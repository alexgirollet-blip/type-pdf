// mcp.js — TypePDF as a Claude connector (a remote MCP server, Streamable HTTP, JSON replies).
//
// Add it once in Claude (Settings → Connectors → Add custom connector) with your own connector link from TypePDF
// (Export for AI → Connect Claude). Then in any Claude chat: "mark my paper", and Claude can
//   list_papers               see your papers (newest first), and which are ready to mark
//   get_paper_for_marking     the marking instructions, your answers (JSON) and your handwriting (images)
//   get_page                  a picture of any page of the paper, with what you wrote on it
//   get_marking               the marking already on the paper (to talk it through)
//   submit_marking            send the marking: it appears on the paper in TypePDF straight away
// The link holds a secret: anyone with it can read your papers' answers and mark them, so it can be reset.

const TOOLS = [
  { name: "list_papers", description: "List the user's TypePDF papers, newest first. 'ready' means the paper has been prepared for marking (the user pressed Mark with Claude or Export for AI); only ready papers can be fetched.", inputSchema: { type: "object", properties: { limit: { type: "integer", description: "How many (default 15)" } } } },
  { name: "get_paper_for_marking", description: "Get everything needed to mark a paper: the marking instructions (follow them exactly), the user's answers as JSON (every answer has an id), and images of their handwriting (one per question part, captioned). Then look at pages with get_page where the question or a diagram matters, and send the marking with submit_marking.", inputSchema: { type: "object", properties: { paperId: { type: "string", description: "From list_papers. Leave out for the paper most recently prepared for marking." } } } },
  { name: "get_page", description: "A picture of one page of the paper (1-based), with the user's handwriting on it. Typed answers are in the answers JSON instead.", inputSchema: { type: "object", properties: { paperId: { type: "string" }, page: { type: "integer" } }, required: ["page"] } },
  { name: "get_marking", description: "The marking currently on a paper (TypePDF marking JSON), to discuss it or improve it.", inputSchema: { type: "object", properties: { paperId: { type: "string" } } } },
  { name: "submit_marking", description: "Send the finished marking (TypePDF marking JSON, as described in the instructions from get_paper_for_marking). It appears on the paper in TypePDF straight away, like a teacher's red pen. Check every id comes from the answers JSON.", inputSchema: { type: "object", properties: { paperId: { type: "string" }, marking: { description: "The marking: a JSON object (or a string of JSON) with format, version, summary and parts.", oneOf: [{ type: "object" }, { type: "string" }] } }, required: ["marking"] } },
];
const INSTRUCTIONS = "TypePDF is where the user answers exam papers. To mark one: get_paper_for_marking (latest prepared paper if no id), read the instructions it returns, use get_page for the pages you need to see, mark strictly against the exam board's standard, then submit_marking. Tell the user their score and the main points briefly once it's sent.";

const rpc = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = t => ({ type: "text", text: t });

// io: { listPapers(limit), pack(doc, what), latestPack(), marking(doc), submit(doc, marking) }
export async function handleMcp(req, io) {
  if (req.method === "GET") return new Response("TypePDF connector: add this link in Claude as a custom connector.", { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response(null, { status: 405 });
  let body; try { body = await req.json(); } catch { return json(rpcErr(null, -32700, "Parse error")); }
  const batch = Array.isArray(body), out = [];
  for (const m of batch ? body : [body]) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") { out.push(rpcErr(m && m.id, -32600, "Invalid request")); continue; }
    if (m.id === undefined) continue;                                  // a notification: nothing to send back
    try { out.push(rpc(m.id, await call(m.method, m.params || {}, io))); }
    catch (e) { out.push(rpcErr(m.id, e.code || -32603, String(e.message || e))); }
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(batch ? out : out[0]);
}
const json = d => new Response(JSON.stringify(d), { headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function call(method, p, io) {
  if (method === "initialize") return { protocolVersion: typeof p.protocolVersion === "string" ? p.protocolVersion : "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "TypePDF", version: "1.0.0" }, instructions: INSTRUCTIONS };
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "resources/list") return { resources: [] };
  if (method === "prompts/list") return { prompts: [] };
  if (method !== "tools/call") throw Object.assign(new Error("Method not found"), { code: -32601 });
  const a = p.arguments || {};
  try { return { content: await tool(p.name, a, io) }; }
  catch (e) { return { content: [text(String(e.message || e))], isError: true }; }
}

async function paperFor(a, io) {
  if (a.paperId) return String(a.paperId);
  const l = await io.latestPack(); if (!l) throw new Error("No paper is ready to mark. In TypePDF, open the paper and press ✓ Marks → Mark with Claude (or Export for AI) first.");
  return l;
}
async function tool(name, a, io) {
  if (name === "list_papers") {
    const papers = await io.listPapers(Math.max(1, Math.min(50, +a.limit || 15)));
    if (!papers.length) return [text("No papers yet.")];
    return [text(papers.map(d => `- ${d.name} (id ${d.id})${d.ready ? " · ready to mark" : ""}${d.marked ? " · marked" : ""} · ${d.filled || 0}/${d.total || 0} answered · updated ${new Date(d.updated).toISOString().slice(0, 16).replace("T", " ")}`).join("\n"))];
  }
  if (name === "get_paper_for_marking") {
    const doc = await paperFor(a, io), meta = await io.pack(doc, "meta");
    if (!meta) throw new Error("That paper hasn't been prepared for marking yet: open it in TypePDF and press ✓ Marks → Mark with Claude.");
    const m = JSON.parse(meta), prompt = await io.pack(doc, "prompt"), answers = await io.pack(doc, "answers"), out = [];
    out.push(text(`${prompt}\n\n## answers.json\n${answers}\n\nThe paper has ${m.pages} pages${m.pageNotes ? " (" + m.pageNotes + ")" : ""}: see any of them with get_page. ${m.work ? `Below: ${m.work} image(s) of the handwriting.` : "There is no handwriting."} When done, call submit_marking with paperId "${doc}".`));
    for (let i = 0; i < (m.work || 0); i++) {
      const w = await io.pack(doc, "work:" + i); if (!w) continue;
      const { label, data } = JSON.parse(w);
      out.push(text(`Handwriting image ${i + 1}: ${label}`), { type: "image", data, mimeType: "image/jpeg" });
    }
    return out;
  }
  if (name === "get_page") {
    const doc = await paperFor(a, io), n = +a.page, pg = await io.pack(doc, "page:" + (n - 1));
    if (!pg) throw new Error(`No page ${a.page} (pages start at 1; the paper may need preparing for marking again).`);
    return [text(`Page ${n}`), { type: "image", data: pg, mimeType: "image/jpeg" }];
  }
  if (name === "get_marking") {
    const doc = await paperFor(a, io), mk = await io.marking(doc);
    return [text(mk ? mk : "This paper has no marking yet.")];
  }
  if (name === "submit_marking") {
    const doc = await paperFor(a, io);
    let mk = a.marking;
    if (typeof mk === "string") { try { mk = JSON.parse(mk.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { throw new Error("marking isn't valid JSON."); } }
    if (!mk || !Array.isArray(mk.parts) || !mk.parts.length) throw new Error("The marking needs a parts list (one entry per answer id).");
    const meta = await io.pack(doc, "meta"), m = meta ? JSON.parse(meta) : {};
    Object.assign(mk, { format: "typepdf-marking", version: 1, paperId: m.paperId || doc, ...(m.exported ? { exported: m.exported } : {}) });
    mk.marker ||= "Claude"; mk.markedAt ||= new Date().toISOString();
    await io.submit(doc, mk, "Claude (connector)");
    const s = mk.summary || {};
    return [text(`Sent to TypePDF${s.score != null ? `: ${s.score}/${s.outOf}${s.grade ? ", grade " + s.grade : ""}` : ""}. The marks are on the paper now (or will be the next time it's opened). ${mk.parts.length} part(s) marked.`)];
  }
  throw new Error("Unknown tool " + name);
}
