import React from "react";
import { Modal, Link } from "@carbon/react";
import { get } from "../api";

type About = { name: string; version: string | null; copyright: string; licence: string; licence_url: string; apache_url: string; source_url: string; trademarks_url: string };

/** The legal notices and the source offer, from GET /auth/about (open before sign-in). AGPL-3.0 §5(d) and §13 ask that
 *  every user of the interface can see them, so they are a help-panel item and a line on the sign-in page. */
function useAbout(): About | null {
  const [a, setA] = React.useState<About | null>(null);
  React.useEffect(() => { get("/auth/about").then((x) => setA(x as About), () => setA(null)); }, []);
  return a;
}

const out = { target: "_blank", rel: "noopener noreferrer" } as const;

export function AboutModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const a = useAbout();
  return (
    <Modal open={open} passiveModal size="sm" modalHeading="About archigov" onRequestClose={onClose}>
      {a && <div className="ag-about">
        <p className="ag-body ag-strong">{a.name}{a.version ? ` ${a.version}` : ""}</p>
        <p className="ag-body">{a.copyright}.</p>
        <p className="ag-body">archigov is free software: you can redistribute it and modify it under the terms of the <Link inline href={a.licence_url} {...out}>GNU Affero General Public License, version 3</Link>. Policy packs, assessment templates, connectors and importers are under the <Link inline href={a.apache_url} {...out}>Apache License 2.0</Link>.</p>
        <p className="ag-body">It is distributed in the hope that it will be useful, but without any warranty; without even the implied warranty of merchantability or fitness for a particular purpose. See the licence for details.</p>
        <p className="ag-body">Everyone who uses it over a network is entitled to its source: <Link inline href={a.source_url} {...out}>the source of this version</Link>.</p>
        <p className="ag-muted ag-label">archigov and the plumb mark are trademarks of Skygge Ltd; the licences grant no right to use them. <Link inline size="sm" href={a.trademarks_url} {...out}>Trademark policy</Link></p>
      </div>}
    </Modal>
  );
}

/** One line for the sign-in page: version, copyright, licence, no warranty, source. */
export function LegalLine() {
  const a = useAbout();
  if (!a) return null;
  return (
    <p className="ag-muted ag-label">
      {a.name}{a.version ? ` ${a.version}` : ""} · {a.copyright} · <Link inline size="sm" href={a.licence_url} {...out}>AGPL-3.0</Link>, without warranty · <Link inline size="sm" href={a.source_url} {...out}>Source</Link>
    </p>
  );
}
