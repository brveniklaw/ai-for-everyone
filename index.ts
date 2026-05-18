// ─────────────────────────────────────────────────────────────────────────────
// Supabase Edge Function: generate-certificate
// Called when a user completes all 30 days
// Generates a certificate record and returns a shareable URL
//
// Deploy: supabase functions deploy generate-certificate
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ── Verify the requesting user is authenticated ────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response("Unauthorized", { status: 401 });
  }

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    // ── Verify user has actually completed all 30 days ─────────────────────
    const { data: progressData, error: progressError } = await supabase
      .from("progress")
      .select("day_number")
      .eq("user_id", user.id);

    if (progressError) throw progressError;

    const completedDays = progressData?.map((p) => p.day_number) ?? [];
    const allDays = Array.from({ length: 30 }, (_, i) => i + 1);
    const allCompleted = allDays.every((d) => completedDays.includes(d));

    if (!allCompleted) {
      const remaining = allDays.filter((d) => !completedDays.includes(d));
      return new Response(
        JSON.stringify({
          success: false,
          message: `${remaining.length} days remaining`,
          remaining_days: remaining,
        }),
        { headers: { "Content-Type": "application/json" }, status: 400 }
      );
    }

    // ── Check if certificate already exists ───────────────────────────────
    const { data: existingCert } = await supabase
      .from("certificates")
      .select("certificate_id, issued_at")
      .eq("user_id", user.id)
      .single();

    if (existingCert) {
      return new Response(
        JSON.stringify({
          success: true,
          already_issued: true,
          certificate_id: existingCert.certificate_id,
          issued_at: existingCert.issued_at,
          certificate_url: `${Deno.env.get("APP_URL")}/certificate/${existingCert.certificate_id}`,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Get user profile for certificate ──────────────────────────────────
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, email, enrolled_at")
      .eq("id", user.id)
      .single();

    // ── Generate unique certificate ID ────────────────────────────────────
    const certId = `AIFE-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    // ── Insert certificate record ──────────────────────────────────────────
    const { data: cert, error: certError } = await supabase
      .from("certificates")
      .insert({
        user_id: user.id,
        certificate_id: certId,
        recipient_name: profile?.full_name ?? profile?.email ?? "Learner",
        email: profile?.email,
        enrolled_at: profile?.enrolled_at,
        completed_at: new Date().toISOString(),
        days_completed: 30,
        program_name: "AI for Everyone — 30-Day Training Program",
      })
      .select()
      .single();

    if (certError) throw certError;

    // ── Update profile to mark completion ─────────────────────────────────
    await supabase
      .from("profiles")
      .update({ completed_at: new Date().toISOString(), completed_days: 30 })
      .eq("id", user.id);

    return new Response(
      JSON.stringify({
        success: true,
        certificate_id: certId,
        issued_at: cert.created_at,
        certificate_url: `${Deno.env.get("APP_URL")}/certificate/${certId}`,
        recipient_name: cert.recipient_name,
      }),
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Certificate generation error:", err);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
});
