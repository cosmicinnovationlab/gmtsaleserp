import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { findUserById, getState } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const session = getSessionFromRequest(request);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await findUserById(session.id);
    if (!user || !user.active) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const state = await getState(user);
    return NextResponse.json(state);
  } catch (err) {
    console.error("State API error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
