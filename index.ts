// ─────────────────────────────────────────────────────────────────────────────
// Supabase Edge Function: activate-user
// Triggered by Stripe webhook: payment_intent.succeeded
// or checkout.session.completed
//
// Deploy with:
//   supabase functions deploy activate-user
//
// Set secrets with:
//   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxxxx
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJxxx
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@13?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "" // Service role bypasses RLS
);

serve(async (req: Request) => {
  // ── Only allow POST ────────────────────────────────────────────────────────
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = req.headers.get("stripe-signature");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!signature || !webhookSecret) {
    console.error("Missing stripe signature or webhook secret");
    return new Response("Unauthorized", { status: 401 });
  }

  // ── Verify Stripe webhook signature ───────────────────────────────────────
  let event: Stripe.Event;
  try {
    const body = await req.text();
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  console.log(`Received Stripe event: ${event.type}`);

  // ── Handle payment events ──────────────────────────────────────────────────
  try {
    if (
      event.type === "checkout.session.completed" ||
      event.type === "payment_intent.succeeded"
    ) {
      let customerEmail: string | null = null;
      let stripeCustomerId: string | null = null;
      let amountPaid: number = 0;
      let currency: string = "usd";
      let paymentId: string = "";

      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;

        // Only process if payment was actually completed
        if (session.payment_status !== "paid") {
          return new Response(JSON.stringify({ received: true, skipped: true }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        customerEmail = session.customer_details?.email ?? null;
        stripeCustomerId = session.customer as string ?? null;
        amountPaid = session.amount_total ?? 0;
        currency = session.currency ?? "usd";
        paymentId = session.payment_intent as string ?? session.id;

      } else if (event.type === "payment_intent.succeeded") {
        const intent = event.data.object as Stripe.PaymentIntent;
        customerEmail = intent.receipt_email ?? null;
        stripeCustomerId = intent.customer as string ?? null;
        amountPaid = intent.amount_received;
        currency = intent.currency;
        paymentId = intent.id;
      }

      if (!customerEmail) {
        console.error("No customer email found in event");
        return new Response("No email found", { status: 400 });
      }

      console.log(`Activating user: ${customerEmail}`);

      // ── Check if profile already exists ─────────────────────────────────
      const { data: existingProfile } = await supabase
        .from("profiles")
        .select("id, is_paid")
        .eq("email", customerEmail)
        .single();

      if (existingProfile?.is_paid) {
        console.log(`User ${customerEmail} already activated — skipping`);
        return new Response(JSON.stringify({ received: true, already_active: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // ── Upsert profile with payment activation ───────────────────────────
      const { error: profileError } = await supabase
        .from("profiles")
        .upsert(
          {
            email: customerEmail,
            is_paid: true,
            enrolled_at: new Date().toISOString(),
            stripe_customer_id: stripeCustomerId,
            payment_id: paymentId,
            amount_paid: amountPaid,
            currency: currency,
          },
          { onConflict: "email" }
        );

      if (profileError) {
        console.error("Error upserting profile:", profileError);
        throw profileError;
      }

      // ── Log the transaction ──────────────────────────────────────────────
      const { error: txError } = await supabase
        .from("transactions")
        .insert({
          email: customerEmail,
          stripe_payment_id: paymentId,
          stripe_customer_id: stripeCustomerId,
          amount: amountPaid,
          currency: currency,
          status: "completed",
        });

      if (txError) {
        console.error("Error logging transaction:", txError);
        // Non-fatal — don't throw, profile is already activated
      }

      console.log(`Successfully activated: ${customerEmail}`);

      return new Response(
        JSON.stringify({
          received: true,
          activated: true,
          email: customerEmail,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Handle subscription cancellation ──────────────────────────────────
    if (
      event.type === "customer.subscription.deleted" ||
      event.type === "invoice.payment_failed"
    ) {
      const obj = event.data.object as any;
      const customerId = obj.customer;

      if (customerId) {
        const { error } = await supabase
          .from("profiles")
          .update({ is_paid: false, deactivated_at: new Date().toISOString() })
          .eq("stripe_customer_id", customerId);

        if (error) console.error("Error deactivating user:", error);
        else console.log(`Deactivated customer: ${customerId}`);
      }
    }

    // All other events — acknowledge receipt
    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(`Server Error: ${err.message}`, { status: 500 });
  }
});
