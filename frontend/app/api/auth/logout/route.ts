import { NextResponse } from "next/server";

const backendUrl = process.env.AGENT_BACKEND_URL ?? "http://localhost:8787";

function sessionToken(request: Request) {
  return request.headers.get("cookie")?.match(/(?:^|;\s*)cadence_session=([^;]+)/)?.[1] ?? "";
}

export async function POST(request: Request) {
  try {
    const response = await fetch(`${backendUrl}/api/auth/logout`, {
      method: "POST",
      headers: { "x-wallet-token": sessionToken(request) },
    });
    const result = new NextResponse(await response.text(), { status: response.status, headers: { "content-type": "application/json" } });
    result.cookies.delete("cadence_session");
    return result;
  } catch {
    return NextResponse.json({ error: "Agent backend is unavailable." }, { status: 503 });
  }
}
