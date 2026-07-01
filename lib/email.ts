import 'server-only';

interface PurchaseEmailParams {
  to: string;
  name: string;
  credits: number;
  amountPaidCents: number;
  isSubscription: boolean;
  planName?: string;
}

export async function sendPurchaseConfirmationEmail({
  to,
  name,
  credits,
  amountPaidCents,
  isSubscription,
  planName,
}: PurchaseEmailParams) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[Email] RESEND_API_KEY not configured — skipping confirmation to ${to}`);
    return;
  }

  const displayName = name || to.split('@')[0];
  const formattedAmount = `$${(amountPaidCents / 100).toFixed(2)}`;
  const subject = isSubscription
    ? `You're subscribed to the ${planName} plan`
    : `${credits} credits added to your account`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;padding:40px 0;margin:0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">
    <div style="background:#111827;padding:24px 32px">
      <p style="color:#fff;font-size:20px;font-weight:700;margin:0">Leak</p>
    </div>
    <div style="padding:32px">
      <h1 style="font-size:22px;font-weight:700;color:#111827;margin:0 0 8px">
        ${isSubscription ? `Welcome to ${planName}!` : 'Credits added'}
      </h1>
      <p style="color:#6b7280;margin:0 0 24px">Hi ${displayName},</p>
      ${
        isSubscription
          ? `<p style="color:#374151">Your <strong>${planName}</strong> subscription is now active.
             You'll receive <strong>${credits} credits</strong> each month, starting today.</p>`
          : `<p style="color:#374151"><strong>${credits} credits</strong> have been added to your account
             and are ready to use.</p>`
      }
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:24px 0">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px">
          <span style="color:#6b7280;font-size:14px">${isSubscription ? 'Plan' : 'Credits'}</span>
          <span style="color:#111827;font-size:14px;font-weight:600">
            ${isSubscription ? `${planName} (${credits}/mo)` : `${credits} credits`}
          </span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="color:#6b7280;font-size:14px">Amount charged</span>
          <span style="color:#111827;font-size:14px;font-weight:600">${formattedAmount}${isSubscription ? '/month' : ''}</span>
        </div>
      </div>
      <a href="${process.env.NEXT_PUBLIC_APP_URL ?? 'https://leak.competemath.com'}/account"
         style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px">
        View account
      </a>
    </div>
    <div style="border-top:1px solid #e5e7eb;padding:16px 32px">
      <p style="color:#9ca3af;font-size:12px;margin:0">
        You received this email because you made a purchase on Leak.
        To manage your subscription, visit your account page.
      </p>
    </div>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'Leak <noreply@leak.competemath.com>',
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    console.error('[Email] Resend API error:', await res.text());
  }
}
