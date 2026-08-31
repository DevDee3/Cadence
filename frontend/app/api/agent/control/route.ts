import { NextResponse } from "next/server";

const backendUrl = process.env.AGENT_BACKEND_URL ?? "http://localhost:8787";

function sessionToken(request: Request) {
  return request.headers.get("cookie")?.match(/(?:^|;\s*)cadence_session=([^;]+)/)?.[1] ?? "";
}

export async function POST(request: Request) {
  try {
    const body = await request.text();
    const response = await fetch(`${backendUrl}/api/agent/control`, {
      method: "POST",
      // This secret stays server-side; it is never exposed to the browser.
      headers: {
        "content-type": "application/json",
        "x-agent-api-key": process.env.AGENT_BACKEND_API_KEY ?? "",
        "x-wallet-token": sessionToken(request),
      },
      body,
      cache: "no-store",
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "Agent backend is unavailable." }, { status: 503 });
  }
}
