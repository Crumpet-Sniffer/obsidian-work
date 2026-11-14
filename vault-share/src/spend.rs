//! What calls to Claude cost: pricing per model, and the daily spend chart on the admin page.
//!
//! Costs are worked out from the token counts in each reply and Anthropic's list prices (US dollars), stored
//! in millionths of a dollar, and shown in pounds at the exchange rate an admin sets. They are estimates:
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

pub fn gbp(micro_usd: i64, rate: f64) -> f64 {
    micro_usd as f64 / 1_000_000.0 * rate
}

/// "£1.23", or three decimals for amounts under 10p so small sums do not all read "£0.00".
pub fn fmt_gbp(v: f64) -> String {
    if v > 0.0 && v < 0.10 {
        format!("£{v:.3}")
    } else {
        format!("£{v:.2}")
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
    pub calls_month: i64,
    pub rate: String,
    pub rate_manual: bool,
    pub rate_note: String,
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
        format!("£{v:.3}")
    } else if top < 10.0 {
        format!("£{v:.2}")
    } else {
        format!("£{v:.0}")
    }
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
        r#"<svg class="spend-chart" viewBox="0 0 {w} {h}" role="img" aria-label="Estimated API spend per day in pounds, last {DAYS} days" data-spend-chart>"#
    );
    // Recessive grid: four lines, labelled in pounds.
    for i in 0..=4 {
        let frac = i as f64 / 4.0;
        let y = base - ph * frac;
        s += &format!(r#"<line class="grid{}" x1="{left}" x2="{:.1}" y1="{y:.1}" y2="{y:.1}"/>"#, if i == 0 { " base" } else { "" }, w - right);
        s += &format!(r#"<text class="tick" x="{:.1}" y="{:.1}" text-anchor="end">{}</text>"#, left - 8.0, y + 4.0, axis_label(ceil * frac, ceil));
    }
    // The line, with a faint wash beneath it down to the baseline.
    let line: String = (0..amounts.len())
        .map(|i| {
            let (x, y) = point(i);
            format!("{}{x:.1},{y:.1}", if i == 0 { "M" } else { "L" })
        })
        .collect();
    let (x_first, x_last) = (point(0).0, point(amounts.len() - 1).0);
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
            fmt_gbp(amounts[i]),
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

pub async fn view(db: &Db, rate_info: crate::handlers::ingest::Rate) -> anyhow::Result<SpendView> {
    let rate = rate_info.value;
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
    let amounts: Vec<f64> = micro.iter().map(|m| gbp(*m, rate)).collect();
    let sum = |from: usize| -> f64 { amounts[from..].iter().sum() };
    let (all_micro, all_calls) = db.usage_total().await?;
    let models = db
        .usage_by_model(first * 86_400)
        .await?
        .into_iter()
        .map(|(model, cost, n)| ModelRow { model, calls: n, amount: fmt_gbp(gbp(cost, rate)) })
        .collect();
    Ok(SpendView {
        today: fmt_gbp(amounts[DAYS as usize - 1]),
        week: fmt_gbp(sum(DAYS as usize - 7)),
        month: fmt_gbp(sum(0)),
        all_time: fmt_gbp(gbp(all_micro, rate)),
        calls_month: calls.iter().sum(),
        rate: format!("{rate}"),
        rate_manual: rate_info.manual,
        rate_note: rate_info.note,
        chart_svg: chart(first, &amounts, &calls),
        days: (0..DAYS as usize)
            .rev()
            .filter(|i| calls[*i] > 0)
            .map(|i| Day { label: day_label(first + i as i64), amount: fmt_gbp(amounts[i]), calls: calls[i] })
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
        assert_eq!(fmt_gbp(0.0), "£0.00");
        assert_eq!(fmt_gbp(0.0221), "£0.022");
        assert_eq!(fmt_gbp(3.456), "£3.46");
    }
}
