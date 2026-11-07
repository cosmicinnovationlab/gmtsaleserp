import { NextResponse } from "next/server";
import { getSessionFromRequest, verifyPassword, hashPassword } from "@/lib/auth";
import { findUserById, updateUserPassword } from "@/lib/db";

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

    const { oldPassword, newPassword } = await request.json();
    if (!newPassword || newPassword.length < 6) {
      return NextResponse.json(
        { error: "New password must be at least 6 characters" },
        { status: 400 }
      );
    }

    // If mustChange is false, require valid old password
    if (!user.mustChange) {
      if (!oldPassword || !verifyPassword(oldPassword, user.password)) {
        return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
      }
    }

    const newHash = hashPassword(newPassword);
    await updateUserPassword(user.id, newHash);

    return NextResponse.json({ ok: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("Password API error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
