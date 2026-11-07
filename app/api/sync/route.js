import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { findUserById, applySyncOps } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const session = getSessionFromRequest(request);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await findUserById(session.id);
    if (!user || !user.active) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const ops = body?.ops || [];

    const result = await applySyncOps(ops, user);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Sync API error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
