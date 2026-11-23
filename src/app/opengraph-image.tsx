import { ImageResponse } from "next/og";
import { MarkSvg } from "./brand-image";

export const alt = "HomeFix — AI-assisted maintenance for UK lettings";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  const chip = { padding: "10px 22px", borderRadius: 999, border: "2px solid #dce1de", color: "#17201d", fontSize: 26 };
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "#f6f7f5" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <MarkSvg size={96} />
          <span style={{ fontSize: 64, fontWeight: 700, color: "#17201d" }}>HomeFix</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <span style={{ fontSize: 46, color: "#17201d", lineHeight: 1.2 }}>
            The model proposes, code decides, people approve.
          </span>
          <span style={{ fontSize: 30, color: "#56625e" }}>
            An AI maintenance agent with guardrails, evals on every run, and an operations view.
          </span>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <span style={chip}>Tenant portal</span>
          <span style={chip}>Operations</span>
          <span style={chip}>Agent Inspector</span>
        </div>
      </div>
    ),
    size,
  );
}
