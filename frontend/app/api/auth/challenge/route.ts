import { NextResponse } from "next/server";

const backendUrl = process.env.AGENT_BACKEND_URL ?? "http://localhost:8787";

export async function POST(request: Request) {
  try {
    const response = await fetch(`${backendUrl}/api/auth/challenge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-api-key": process.env.AGENT_BACKEND_API_KEY ?? "",
      },
      body: await request.text(),
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
