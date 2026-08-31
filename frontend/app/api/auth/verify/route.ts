import { NextResponse } from "next/server";

const backendUrl = process.env.AGENT_BACKEND_URL ?? "http://localhost:8787";

export async function POST(request: Request) {
  try {
    const response = await fetch(`${backendUrl}/api/auth/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-api-key": process.env.AGENT_BACKEND_API_KEY ?? "",
      },
      body: await request.text(),
      cache: "no-store",
    });
    const body = await response.text();
    const result = new NextResponse(body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
    if (response.ok) result.cookies.set("cadence_session", JSON.parse(body).token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24, path: "/" });
    return result;
  } catch {
    return NextResponse.json({ error: "Agent backend is unavailable." }, { status: 503 });
  }
}
