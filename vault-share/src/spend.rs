//! What calls to Claude cost: pricing per model, and the daily spend chart on the admin page.
//!
//! Costs are worked out from the token counts in each reply and Anthropic's list prices (US dollars), stored
//! in millionths of a dollar, and shown in dollars, as Anthropic charges. They are estimates:
//! the invoice from Anthropic is what is actually charged.

use crate::db::{now, Db};

/// Token counts from one reply.
#[derive(Default, Clone, Copy)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

/// List price in US dollars per million tokens: (input, output, cache read). `prompt` is the size of the
/// whole prompt, which changes the rate on models priced in tiers.
fn price(model: &str, prompt: u64) -> Option<(f64, f64, f64)> {
    let m = model;
    Some(if m.starts_with("claude-fable-5-2") || m.starts_with("claude-mythos-5-2") {
        (8.0, 40.0, 0.20)
    } else if m.starts_with("claude-fable-5") || m.starts_with("claude-mythos-5") {
        (10.0, 50.0, 1.0)
    } else if m.starts_with("claude-opus-5-5") {
        (4.0, 20.0, 0.20)
    } else if m.starts_with("claude-opus-5") || m.starts_with("claude-opus-4") {
        (5.0, 25.0, 0.50)
    } else if m.starts_with("claude-sonnet-5-5") {
        (2.0, 10.0, 0.10)
    } else if m.starts_with("claude-sonnet-5") {
        (2.0, 10.0, 0.20)
    } else if m.starts_with("claude-sonnet-4") {
        (3.0, 15.0, 0.30)
    } else if m.starts_with("claude-haiku-5-5") {
        if prompt > 100_000 { (0.50, 2.50, 0.05) } else { (0.10, 0.50, 0.01) }
    } else if m.starts_with("claude-haiku-4") {
        (1.0, 5.0, 0.10)
    } else {
        return None;
    })
}

/// Cost of one reply in millionths of a US dollar. `answered_by` is the model named in the reply (a
/// substitute model can answer); `asked` is the one that was requested, used when the other is unknown.
pub fn cost_micro_usd(answered_by: &str, asked: &str, t: Tokens) -> i64 {
    let prompt = t.input + t.cache_read + t.cache_write;
    let (pin, pout, pread) = price(answered_by, prompt).or_else(|| price(asked, prompt)).unwrap_or((0.0, 0.0, 0.0));
    // Writing to the cache costs a quarter more than plain input.
    let usd_per_million =
        t.input as f64 * pin + t.cache_write as f64 * pin * 1.25 + t.cache_read as f64 * pread + t.output as f64 * pout;
    usd_per_million.round() as i64 // dollars-per-million times tokens is already millionths of a dollar
}

/// Millionths of a dollar as dollars.
pub fn usd(micro_usd: i64) -> f64 {
    micro_usd as f64 / 1_000_000.0
}

/// "$1.23", or three decimals for amounts under 10 cents so small sums do not all read "$0.00".
pub fn fmt_usd(v: f64) -> String {
    if v > 0.0 && v < 0.10 {
        format!("${v:.3}")
    } else {
        format!("${v:.2}")
    }
}

pub struct Day {
    pub label: String,
    pub amount: String,
    pub calls: i64,
}

pub struct ModelRow {
    pub model: String,
    pub calls: i64,
    pub amount: String,
}

pub struct SpendView {
    pub today: String,
    pub week: String,
    pub month: String,
    pub all_time: String,
    pub calls_today: i64,
    pub calls_week: i64,
    pub calls_month: i64,
    pub calls_all: i64,
    pub chart_svg: String,
    pub days: Vec<Day>,
    pub models: Vec<ModelRow>,
    pub any: bool,
}

const DAYS: i64 = 30;
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "14 Nov" for a day number (days since 1970-01-01, UTC).
fn day_label(day: i64) -> String {
    // civil-from-days (Howard Hinnant's algorithm)
    let z = day + 719_468;
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{d} {}", MONTHS[(m - 1) as usize])
}

/// A round number at or above `v` to end the axis on: 1, 2 or 5 times a power of ten.
fn nice_ceiling(v: f64) -> f64 {
    if v <= 0.0 {
        return 1.0;
    }
    let pow = 10f64.powf(v.log10().floor());
    for step in [1.0, 2.0, 5.0, 10.0] {
        if step * pow >= v {
            return step * pow;
        }
    }
    10.0 * pow
}

fn axis_label(v: f64, top: f64) -> String {
    if top < 0.1 {
        format!("${v:.3}")
    } else if top < 10.0 {
        format!("${v:.2}")
    } else {
        format!("${v:.0}")
    }
}

/// An SVG path through the points as a smooth curve (monotone cubic interpolation, Fritsch–Carlson): it passes
/// through every point and never overshoots between two of them, so a quiet day stays on the baseline.
fn smooth_path(pts: &[(f64, f64)]) -> String {
    let n = pts.len();
    if n == 0 {
        return String::new();
    }
    let mut d = format!("M{:.1},{:.1}", pts[0].0, pts[0].1);
    if n == 1 {
        return d;
    }
    // Slopes between neighbours, then a tangent at each point that keeps the curve monotone.
    let secant: Vec<f64> = (0..n - 1).map(|i| (pts[i + 1].1 - pts[i].1) / (pts[i + 1].0 - pts[i].0)).collect();
    let mut m = vec![0.0; n];
    m[0] = secant[0];
    m[n - 1] = secant[n - 2];
    for i in 1..n - 1 {
        m[i] = if secant[i - 1] * secant[i] <= 0.0 { 0.0 } else { (secant[i - 1] + secant[i]) / 2.0 };
    }
    for i in 0..n - 1 {
        if secant[i] == 0.0 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
            continue;
        }
        let (a, b) = (m[i] / secant[i], m[i + 1] / secant[i]);
        let h = a * a + b * b;
        if h > 9.0 {
            let t = 3.0 / h.sqrt();
            m[i] = t * a * secant[i];
            m[i + 1] = t * b * secant[i];
        }
    }
    for i in 0..n - 1 {
        let ((x0, y0), (x1, y1)) = (pts[i], pts[i + 1]);
        let dx = (x1 - x0) / 3.0;
        d += &format!("C{:.1},{:.1} {:.1},{:.1} {x1:.1},{y1:.1}", x0 + dx, y0 + m[i] * dx, x1 - dx, y1 - m[i + 1] * dx);
    }
    d
}

/// A line of spend per day, drawn on the server so the page needs no chart library. Only numbers and fixed
/// text go into the markup.
fn chart(first_day: i64, amounts: &[f64], calls: &[i64]) -> String {
    let (w, h) = (720.0, 240.0);
    let (left, right, top, bottom) = (52.0, 12.0, 12.0, 28.0);
    let (pw, ph) = (w - left - right, h - top - bottom);
    let max = amounts.iter().cloned().fold(0.0, f64::max);
    let ceil = nice_ceiling(max);
    let n = amounts.len() as f64;
    let slot = pw / n;
    let base = top + ph;
    let point = |i: usize| (left + slot * (i as f64 + 0.5), base - ph * amounts[i] / ceil);
    let mut s = format!(
        r#"<svg class="spend-chart" viewBox="0 0 {w} {h}" role="img" aria-label="Estimated API spend per day in US dollars, last {DAYS} days" data-spend-chart>"#
    );
    // Recessive grid: four lines, labelled in dollars.
    for i in 0..=4 {
        let frac = i as f64 / 4.0;
        let y = base - ph * frac;
        s += &format!(r#"<line class="grid{}" x1="{left}" x2="{:.1}" y1="{y:.1}" y2="{y:.1}"/>"#, if i == 0 { " base" } else { "" }, w - right);
        s += &format!(r#"<text class="tick" x="{:.1}" y="{:.1}" text-anchor="end">{}</text>"#, left - 8.0, y + 4.0, axis_label(ceil * frac, ceil));
    }
    // The line, with a faint wash beneath it down to the baseline. It is a smooth curve through every day's
    // figure that never overshoots: it does not dip below zero or rise above a peak between two days.
    let pts: Vec<(f64, f64)> = (0..amounts.len()).map(point).collect();
    let line = smooth_path(&pts);
    let (x_first, x_last) = (pts[0].0, pts[pts.len() - 1].0);
    s += &format!(r#"<path class="area" d="{line}L{x_last:.1},{base:.1}L{x_first:.1},{base:.1}Z"/>"#);
    s += &format!(r#"<path class="line" d="{line}"/>"#);
    // One column per day carries the hover: a guide, a marker on the line, and the figures.
    for i in 0..amounts.len() {
        let (cx, cy) = point(i);
        let x0 = left + slot * i as f64;
        let day = first_day + i as i64;
        let tip = format!(
            "{} · {} · {} call{}",
            day_label(day),
            fmt_usd(amounts[i]),
            calls[i],
            if calls[i] == 1 { "" } else { "s" }
        );
        s += &format!(r#"<g class="day" data-tip="{tip}">"#);
        s += &format!(r#"<rect class="hit" x="{x0:.1}" y="{top}" width="{slot:.1}" height="{ph}"/>"#);
        s += &format!(r#"<line class="guide" x1="{cx:.1}" x2="{cx:.1}" y1="{top}" y2="{base:.1}"/>"#);
        s += &format!(r#"<circle class="dot" cx="{cx:.1}" cy="{cy:.1}" r="4.5"/>"#);
        s += "</g>";
        if i % 5 == 4 || i == 0 {
            s += &format!(r#"<text class="tick" x="{cx:.1}" y="{:.1}" text-anchor="middle">{}</text>"#, h - 8.0, day_label(day));
        }
    }
    s += "</svg>";
    s
}

pub async fn view(db: &Db) -> anyhow::Result<SpendView> {
    let today = now().div_euclid(86_400);
    let first = today - (DAYS - 1);
    let daily = db.usage_by_day(first * 86_400).await?;
    let mut micro = vec![0i64; DAYS as usize];
    let mut calls = vec![0i64; DAYS as usize];
    for (day, cost, n) in daily {
        if (first..=today).contains(&day) {
            micro[(day - first) as usize] = cost;
            calls[(day - first) as usize] = n;
        }
    }
    let amounts: Vec<f64> = micro.iter().map(|m| usd(*m)).collect();
    let sum = |from: usize| -> f64 { amounts[from..].iter().sum() };
    let (all_micro, all_calls) = db.usage_total().await?;
    let models = db
        .usage_by_model(first * 86_400)
        .await?
        .into_iter()
        .map(|(model, cost, n)| ModelRow { model, calls: n, amount: fmt_usd(usd(cost)) })
        .collect();
    Ok(SpendView {
        today: fmt_usd(amounts[DAYS as usize - 1]),
        week: fmt_usd(sum(DAYS as usize - 7)),
        month: fmt_usd(sum(0)),
        all_time: fmt_usd(usd(all_micro)),
        calls_today: calls[DAYS as usize - 1],
        calls_week: calls[DAYS as usize - 7..].iter().sum(),
        calls_month: calls.iter().sum(),
        calls_all: all_calls,
        chart_svg: chart(first, &amounts, &calls),
        days: (0..DAYS as usize)
            .rev()
            .filter(|i| calls[*i] > 0)
            .map(|i| Day { label: day_label(first + i as i64), amount: fmt_usd(amounts[i]), calls: calls[i] })
            .collect(),
        models,
        any: all_calls > 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices() {
        // 12,000 in and 400 out on Sonnet 5.5: 12000 * $2 + 400 * $10 per million = $0.028
        let t = Tokens { input: 12_000, output: 400, ..Default::default() };
        assert_eq!(cost_micro_usd("claude-sonnet-5-5", "claude-sonnet-5-5", t), 28_000);
        // cache reads are cheaper, cache writes dearer
        let t = Tokens { input: 1_000, output: 0, cache_read: 10_000, cache_write: 4_000 };
        assert_eq!(cost_micro_usd("claude-opus-5-5", "x", t), 4_000 + 2_000 + 20_000);
        // an unknown answering model falls back to the one asked for; unknown both ways costs nothing
        assert_eq!(cost_micro_usd("mystery", "claude-sonnet-5-5", Tokens { input: 1_000_000, ..Default::default() }), 2_000_000);
        assert_eq!(cost_micro_usd("mystery", "also-mystery", Tokens { input: 5, ..Default::default() }), 0);
        // Haiku 5.5 costs more past 100K tokens of prompt
        assert_eq!(cost_micro_usd("claude-haiku-5-5", "x", Tokens { input: 200_000, ..Default::default() }), 100_000);
    }

    #[test]
    fn labels_and_axis() {
        assert_eq!(day_label(0), "1 Jan");
        assert_eq!(day_label(20_771), "14 Nov"); // 2026-11-14
        assert_eq!(nice_ceiling(0.0), 1.0);
        assert_eq!(nice_ceiling(0.37), 0.5);
        assert_eq!(nice_ceiling(12.0), 20.0);
        assert_eq!(fmt_usd(0.0), "$0.00");
        assert_eq!(fmt_usd(0.0221), "$0.022");
        assert_eq!(fmt_usd(3.456), "$3.46");
    }

    #[test]
    fn smooth_line_stays_in_range() {
        // A flat run, a spike and back: the curve's control points never go below the baseline or above the peak.
        let pts = [(0.0, 100.0), (10.0, 100.0), (20.0, 20.0), (30.0, 100.0), (40.0, 100.0)];
        let d = smooth_path(&pts);
        assert!(d.starts_with("M0.0,100.0"));
        let ys: Vec<f64> = d
            .split(|c| c == 'C' || c == ' ')
            .filter_map(|p| p.split(',').nth(1))
            .filter_map(|y| y.parse().ok())
            .collect();
        assert!(ys.iter().all(|y| (20.0..=100.0).contains(y)), "{d}");
        assert_eq!(smooth_path(&[(1.0, 2.0)]), "M1.0,2.0");
    }
}
