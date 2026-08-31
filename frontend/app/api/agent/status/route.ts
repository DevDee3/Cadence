import { NextResponse } from "next/server";

const backendUrl = process.env.AGENT_BACKEND_URL ?? "http://localhost:8787";

function sessionToken(request: Request) {
  return request.headers.get("cookie")?.match(/(?:^|;\s*)cadence_session=([^;]+)/)?.[1] ?? "";
}

export async function GET(request: Request) {
  try {
    const response = await fetch(`${backendUrl}/api/agent/status`, { cache: "no-store", headers: { "x-agent-api-key": process.env.AGENT_BACKEND_API_KEY ?? "", "x-wallet-token": sessionToken(request) } });
    const body = await response.text();
    return new NextResponse(body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "Agent backend is unavailable." }, { status: 503 });
  }
}
