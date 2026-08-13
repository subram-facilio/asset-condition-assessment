import StudioFunctions, { StudioDatabase } from "@facilio/studio-functions";

const server = new StudioFunctions({ name: "diag" });

server.addHandler({
  name: "env",
  description: "Report which env and system keys the sandbox injects",
  parameters: {},
  execute: async () => {
    const envKeys = Object.keys(process.env || {});
    const sysKeys = Object.keys((process as any).system || {});
    return { envKeys, sysKeys };
  },
});

server.addHandler({
  name: "db",
  description: "Try a trivial query and a CREATE TABLE to confirm DDL rights",
  parameters: {},
  execute: async () => {
    const db = new StudioDatabase({
      userName: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      schema: process.env.SCHEMA,
    });
    const out: Record<string, unknown> = {};
    try {
      const r = db.query("select current_user as u, current_schema as s");
      out.identity = r.rows;
    } catch (e) {
      out.identityError = String(e);
    }
    try {
      db.query("create table if not exists _ddl_probe (id int)");
      out.ddl = "ok";
      db.query("drop table if exists _ddl_probe");
      out.drop = "ok";
    } catch (e) {
      out.ddlError = String(e);
    }
    return out;
  },
});

server.addHandler({
  name: "conn",
  description: "Call a Facilio CMMS action through the connections service",
  parameters: {},
  execute: async () => {
    const res = await fetch(
      `${(process as any).system.CONNECTIONS_URL}/api/v1/connections/facilio-cmms/actions/list-work-orders/execute`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { page_size: 2, select: "id,subject,type" } }),
      }
    );
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 800) };
  },
});

server.addHandler({
  name: "binfetch",
  description: "Can the sandbox read a JPEG body without corrupting it? Reports length and the leading byte codes.",
  parameters: {
    url: { description: "Pre-signed image URL", type: "string" },
  },
  execute: async (args) => {
    const res = await fetch(String(args.url));
    const txt = await res.text();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push(txt.charCodeAt(i));
    let over255 = 0;
    let replacement = 0;
    for (let i = 0; i < txt.length; i++) {
      const c = txt.charCodeAt(i);
      if (c > 255) over255++;
      if (c === 0xfffd) replacement++;
    }
    return {
      status: res.status,
      declaredType: res.headers.get("content-type"),
      declaredLength: res.headers.get("content-length"),
      textLength: txt.length,
      leadingCodes: codes,
      jpegMagicOk: codes[0] === 0xff && codes[1] === 0xd8,
      charsAbove255: over255,
      replacementChars: replacement,
    };
  },
});

server.execute();
