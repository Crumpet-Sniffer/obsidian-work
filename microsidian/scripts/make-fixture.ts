/**
 * Builds a small sample vault (generic project and research notes with real .docx/.pptx originals)
 * so the tests need no private files. Output: .fixture/vault and .fixture/samples (documents to ingest).
 * Usage: npx tsx scripts/make-fixture.ts
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import JSZip from "jszip";
import { convertOffice } from "../src/convert";
import { addInlineLinks } from "../src/vault/linker";
import { buildHead, composeNote } from "../src/vault/notes";
import { DEFAULT_LAYOUT } from "../src/config";

export const FIXTURE_ROOT = resolve(__dirname, "..", ".fixture");
export const FIXTURE_VAULT = join(FIXTURE_ROOT, "vault");
export const FIXTURE_SAMPLES = join(FIXTURE_ROOT, "samples");

const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// a >30 KB stand-in for an image (the converter only reads bytes)
const fakePng = (seed: number) => {
  const b = Buffer.alloc(40_000, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
};

// ---------- Word ----------
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
export const wr = (t: string, o: { b?: boolean; i?: boolean; u?: boolean } = {}) =>
  `<w:r><w:rPr>${o.b ? "<w:b/>" : ""}${o.i ? "<w:i/>" : ""}${o.u ? '<w:u w:val="single"/>' : ""}</w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
export const wp = (...runs: string[]) => `<w:p>${runs.join("")}</w:p>`;
export const wh1 = (t: string) => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${wr(t)}</w:p>`;
export const wbullet = (t: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${wr(t)}</w:p>`;
export const wlink = (t: string) => `<w:hyperlink r:id="rIdLink1">${wr(t)}</w:hyperlink>`;
export const wtable = (rows: string[][]) =>
  `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${wp(wr(c))}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
export const wtextbox = (t: string) =>
  `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent>${wp(wr(t))}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${wp(wr(t))}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
export const wimage = `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImg1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

export async function makeDocx(body: string[], opts: { image?: number } = {}): Promise<Buffer> {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  z.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body.join("")}<w:sectPr/></w:body></w:document>`);
  z.file("word/styles.xml", `<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`);
  z.file("word/numbering.xml", `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  z.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/budget" TargetMode="External"/>${opts.image ? '<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' : ""}</Relationships>`);
  if (opts.image) z.file("word/media/image1.png", fakePng(opts.image));
  return z.generateAsync({ type: "nodebuffer" });
}

// ---------- PowerPoint ----------
const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
export interface Slide {
  title?: string;
  bullets?: string[];
  text?: string[];
  table?: string[][];
  image?: number;
  notes?: string;
}
const sp = (type: string, paras: string, id: number) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;
const ap = (t: string, bullet = false) => `<a:p>${bullet ? '<a:pPr><a:buChar char="&#8226;"/></a:pPr>' : ""}<a:r><a:t>${x(t)}</a:t></a:r></a:p>`;

export async function makePptx(slides: Slide[]): Promise<Buffer> {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  z.file("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`);
  z.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`);
  slides.forEach((s, i) => {
    const n = i + 1;
    let shapes = "";
    if (s.title) shapes += sp("title", ap(s.title), 2);
    if (s.bullets || s.text) shapes += sp("body", [...(s.text ?? []).map((t) => ap(t)), ...(s.bullets ?? []).map((t) => ap(t, true))].join(""), 3);
    if (s.table) shapes += `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${s.table.map((r) => `<a:tr>${r.map((c) => `<a:tc><a:txBody>${ap(c)}</a:txBody></a:tc>`).join("")}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    if (s.image) shapes += `<p:pic><p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill></p:pic>`;
    z.file(`ppt/slides/slide${n}.xml`, `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`);
    const rels: string[] = [];
    if (s.image) { rels.push(`<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/img${n}.png"/>`); z.file(`ppt/media/img${n}.png`, fakePng(s.image)); }
    if (s.notes) {
      rels.push(`<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`);
      z.file(`ppt/notesSlides/notesSlide${n}.xml`, `<?xml version="1.0"?><p:notes ${P}><p:cSld><p:spTree>${sp("body", ap(s.notes), 2)}</p:spTree></p:cSld></p:notes>`);
    }
    if (rels.length) z.file(`ppt/slides/_rels/slide${n}.xml.rels`, `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
  });
  return z.generateAsync({ type: "nodebuffer" });
}

// ---------- the sample vault ----------
const write = (root: string, rel: string, data: string | Buffer) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), data);
};

const TOPICS: Record<string, { theme: string; definition: string; phrases: string[] }> = {
  "Risk management": { theme: "Delivery", definition: "Finding, ranking and reducing the things that could go wrong in a project.", phrases: ["risk register", "risks", "risk management"] },
  Budget: { theme: "Delivery", definition: "Planning and tracking what a project costs.", phrases: ["budget", "costs"] },
  "User research": { theme: "Discovery", definition: "Learning what users need through interviews and observation.", phrases: ["user research", "interviews", "interview"] },
};

export async function makeFixture(): Promise<void> {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  const vault = FIXTURE_VAULT;
  const O = DEFAULT_LAYOUT.originals;

  const docs: { folder: string; name: string; ext: "docx" | "pptx"; data: Buffer; topics: string[]; related: string[] }[] = [
    {
      folder: "Projects/Alpha", name: "Kickoff", ext: "pptx", topics: ["Risk management", "Budget"], related: ["Projects/Alpha/Requirements"],
      data: await makePptx([
        { title: "Alpha project kickoff", text: ["Goals and scope for the first release."] },
        { title: "Budget and risks", bullets: ["The budget is 40k.", "Every risk goes in the risk register.", "Costs are reviewed weekly."], notes: "Mention the budget freeze." },
        { title: "Timeline", table: [["Phase", "Weeks"], ["Design", "4"], ["Build", "8"]], image: 3 },
      ]),
    },
    {
      folder: "Projects/Alpha", name: "Requirements", ext: "docx", topics: ["Budget"], related: ["Projects/Alpha/Kickoff"],
      data: await makeDocx([
        wh1("Requirements"),
        wp(wr("The system must stay inside the "), wr("budget", { b: true }), wr(" agreed at kickoff, see "), wlink("the budget sheet"), wr(".")),
        wbullet("Fast search"), wbullet("Offline mode"),
        wtable([["Requirement", "Priority"], ["Search", "High"], ["Offline", "Low"]]),
        wtextbox("Text box: costs must be signed off by finance."),
        wimage,
      ], { image: 5 }),
    },
    {
      folder: "Research/Interviews", name: "Interview 1", ext: "docx", topics: ["User research"], related: ["Research/Interviews/Findings"],
      data: await makeDocx([wh1("Interview 1"), wp(wr("Notes from the first user research interview. The user wants faster search and fewer clicks.")), wp(wr("Quote: ", { i: true }), wr("I never find anything.", { u: true }))]),
    },
    {
      folder: "Research/Interviews", name: "Findings", ext: "pptx", topics: ["User research", "Risk management"], related: ["Research/Interviews/Interview 1", "Projects/Alpha/Kickoff"],
      data: await makePptx([
        { title: "Research findings" },
        { title: "What interviews showed", bullets: ["Search is slow.", "Users want offline access."], text: ["Based on five interviews."] },
        { title: "Risks", text: ["The main risk is that users abandon the product."] },
      ]),
    },
  ];

  const lookup = new Map(docs.map((d) => [`${d.folder}/${d.name}`, d]));
  for (const d of docs) {
    const orig = `${O}/${d.folder}/${d.name}.${d.ext}`;
    write(vault, orig, d.data);
    const res = await convertOffice(d.data, d.ext, { imageMinBytes: 30_000, isLogo: () => false, attachmentsDir: DEFAULT_LAYOUT.attachments, originalPath: orig });
    for (const i of res.images) write(vault, i.path, Buffer.from(i.data));
    const linked = addInlineLinks(res.body, d.topics.map((t) => ({ name: t, phrases: TOPICS[t].phrases })), DEFAULT_LAYOUT.topics);
    const conn = [
      "%% connections:start %%", "", "---", "## Connections", "",
      "**Topics:** " + d.topics.map((t) => `[[Topics/${t}|${t}]]`).join(" · "), "",
      "**Related notes**", ...d.related.map((r) => `- [[${r}|${r.split("/").pop()}]]: related work`), "", "%% connections:end %%",
    ].join("\n");
    write(vault, `${d.folder}/${d.name}.md`, composeNote(buildHead({ source: orig, name: d.name, ext: d.ext }), linked.body, { connections: conn }));
  }
  void lookup;

  // topic pages
  for (const [name, t] of Object.entries(TOPICS)) {
    const users = docs.filter((d) => d.topics.includes(name));
    const sections = [...new Set(users.map((d) => d.folder.split("/")[0]))].sort();
    write(vault, `Topics/${name}.md`, [
      "---", "tags: [topic]", `theme: "${t.theme}"`, `phrases: ${JSON.stringify(t.phrases)}`, "---", "", `# ${name}`, "", `> ${t.definition}`, "",
      `**Theme:** [[Topics - Index#${t.theme}|${t.theme}]]`, "",
      ...sections.flatMap((s) => [`## ${s}`, "", ...users.filter((d) => d.folder.startsWith(s)).map((d) => `- [[${d.folder}/${d.name}|${d.name}]]: 2 mentions`), ""]),
    ].join("\n"));
  }
  const count = (n: string) => docs.filter((d) => d.topics.includes(n)).length;
  write(vault, "Topics - Index.md", [
    "# Topics", "", "[[Home]]", "",
    "## Delivery", "", `- [[Topics/Risk management|Risk management]]: ${count("Risk management")} notes`, `- [[Topics/Budget|Budget]]: ${count("Budget")} notes`, "",
    "## Discovery", "", `- [[Topics/User research|User research]]: ${count("User research")} notes`, "",
  ].join("\n"));

  // folder index notes
  for (const top of ["Projects", "Research"]) {
    const mine = docs.filter((d) => d.folder.startsWith(top));
    const sections = [...new Set(mine.map((d) => d.folder.split("/")[1]))].sort();
    write(vault, `${top} - Index.md`, [`# ${top}`, "", "[[Home]]", "", ...sections.flatMap((s) => [`## ${s}`, "", ...mine.filter((d) => d.folder.split("/")[1] === s).map((d) => `- [[${d.folder}/${d.name}|${d.name}]]`), ""])].join("\n"));
  }
  write(vault, "Home.md", "# Home\n\n- [[Projects - Index]]\n- [[Research - Index]]\n- [[Topics - Index]]\n");

  // documents to ingest in the tests
  write(FIXTURE_ROOT, "samples/Budget Review.docx", await makeDocx([
    wh1("Budget review"), wp(wr("Our budget is under pressure. Every risk on the risk register affects costs, so risk management and budget tracking go together.")),
    wp(wr("Carbon accounting measures the emissions of our hosting.")),
  ]));
  write(FIXTURE_ROOT, "samples/Retrospective.pptx", await makePptx([
    { title: "Sprint retrospective" }, { title: "What went well", bullets: ["Interviews with users were useful.", "The team shared notes."] },
  ]));
  write(FIXTURE_ROOT, "samples/Worksheet.docx", await makeDocx([wh1("Worksheet"), wp(wr("Fill in the blanks: ____"))]));
}

if (require.main === module) {
  makeFixture().then(() => console.log(`sample vault written to ${FIXTURE_ROOT}`));
}

/** Make sure the fixture exists (generate it on first use). */
export async function ensureFixture(): Promise<void> {
  if (!existsSync(join(FIXTURE_VAULT, "Home.md"))) await makeFixture();
}
