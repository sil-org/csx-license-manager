import AppLayout from '../components/AppLayout'
import { getLinks } from '../navLinks'

// Ported from the GAS app's FAQ tab (gas-legacy's faq_replacement.py). A few
// answers were adjusted to describe what this app actually does today rather
// than what GAS did — subscribing on behalf of someone else and automatic
// renewal-reminder emails aren't built yet (see the README's "not ported
// yet" list). Update this copy as each ships.
const SECTIONS = [
  {
    title: 'Getting Started',
    items: [
      {
        q: 'What is License Manager?',
        a: 'License Manager is the central place to browse, subscribe to, and manage software licenses available at SIL. It tracks who is using which tools, which budget is being charged, and handles the full approval and provisioning workflow between users, budget managers, and the GTIS team.',
      },
      {
        q: 'How do I subscribe to a license?',
        a: (
          <>
            Open the <strong>Catalog</strong>, click <em>Request</em> on a license, then choose how to pay
            &mdash; SuiteKey or Ministry ID (for non-GTIS licenses).
            <br /><br />
            What happens next depends on the license:
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>If you own the SuiteKey, or it's GTIS-funded, no approval is needed — it moves straight to <strong>Approved &mdash; being provisioned</strong> while GTIS sets up your seat.</li>
              <li>If approval is needed, the budget manager is notified and your subscription shows as <strong>Awaiting approval</strong>.</li>
              <li>Either way, your subscription only becomes <strong>Active</strong> once GTIS marks it as provisioned &mdash; there's no license today that skips this step.</li>
            </ul>
          </>
        ),
      },
      {
        q: 'Can I subscribe on behalf of someone else?',
        a: 'Not currently — this version only supports subscribing for yourself. Requesting on someone else’s behalf (like the original system allowed) is on the roadmap but not built yet.',
      },
      {
        q: 'What do the different subscription statuses mean?',
        a: (
          <table className="w-full text-sm border-collapse">
            <tbody>
              {[
                ['Awaiting SuiteKey verification', 'Waiting for a suggested SuiteKey manager to confirm they own that budget.'],
                ['Awaiting approval', 'The budget manager has been notified and needs to approve or decline.'],
                ['Approved — being provisioned', 'Approved; GTIS is setting up your account on the vendor side.'],
                ['Active', 'Your license is live and ready to use.'],
                ['Declined / Revoked / Cancelled', 'Declined by the budget manager, revoked by an admin, or cancelled by you.'],
              ].map(([label, desc], i) => (
                <tr key={label} className={i % 2 === 1 ? 'bg-gray-50' : ''}>
                  <td className="p-2 font-medium w-56 align-top">{label}</td>
                  <td className="p-2 align-top">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ),
      },
    ],
  },
  {
    title: 'Billing',
    items: [
      {
        q: 'What is a SuiteKey?',
        a: 'A SuiteKey is a budget cost center code. When you subscribe to a non-GTIS license, you select the SuiteKey that should be charged — that key’s budget manager then approves or declines the request.',
      },
      {
        q: 'What if my SuiteKey is not listed, or has no manager?',
        a: 'You’ll be asked for the email of the person who manages that budget. They’ll be notified to confirm or deny ownership on the Action Center page. If they confirm, they’re registered as the manager and your request moves into the normal approval queue. If they deny it, you’ll need to resubmit with the correct contact.',
      },
      {
        q: 'What is a Ministry ID?',
        a: 'A Ministry ID is a personal 6-digit billing identifier for staff whose costs are covered by a ministry rather than a SuiteKey. No approval is required for this path. Contact the License Manager team if your Ministry ID is missing or needs correcting.',
      },
      {
        q: 'What does "GTIS-sponsored" mean?',
        a: 'GTIS centrally covers the cost of certain licenses. If a license is marked GTIS-sponsored, no SuiteKey or Ministry ID is required — just request it. It still goes through the same provisioning step as everything else, though — GTIS-sponsored only skips the budget-manager approval.',
      },
      {
        q: 'Are subscriptions refundable?',
        a: 'Subscriptions are non-refundable once active. Cancelling stops future renewals but doesn’t issue a credit for the current billing period. If you’re unsure whether you need a license, cancel a pending or not-yet-active subscription before it goes active.',
      },
    ],
  },
  {
    title: 'Managing Subscriptions',
    items: [
      {
        q: 'How do I cancel a subscription?',
        a: 'Go to My Subscriptions and click Cancel. Cancellations are non-refundable once the subscription is active. If the license uses a Google Group, removal is currently handled manually by the License Manager team.',
      },
      {
        q: 'How does renewal work?',
        a: 'Once a subscription is active, My Subscriptions shows Opt in to renew / Opt out buttons — use those to let your budget manager know your plans. Automatic email reminders before each renewal date are planned but not built yet, so check back periodically for now.',
      },
    ],
  },
  {
    title: 'For Budget Managers & Service Managers',
    items: [
      {
        q: 'I own a SuiteKey — how do I manage approval requests?',
        a: 'The Action Center page shows any SuiteKey ownership verifications and subscription approvals waiting on you — it’s empty unless something needs your attention. For a full view of every charge to your SuiteKey(s), not just the pending ones, see SuiteKey Charges in the sidebar.',
      },
      {
        q: 'I manage a license’s vendor setup — where do I provision seats or cancel a request?',
        a: 'Admin → All Subscriptions (also open to service managers, not just admins) lists every subscription to that license — a "Mark active" action with a link to the vendor portal for ones awaiting provisioning, and a Cancel action for any that haven’t already been cancelled or revoked.',
      },
      {
        q: 'I’m a people manager — where can I see my team’s subscriptions?',
        a: 'My Team, in the sidebar, lists every active or pending subscription used by your direct and indirect reports.',
      },
    ],
  },
  {
    title: 'Support',
    items: [
      {
        q: 'How do I get help or report a problem?',
        a: 'Contact the License Manager team directly. When asking about a specific subscription, include its ID from My Subscriptions — it makes it much faster to look up.',
      },
    ],
  },
]

export default function FAQ() {
  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-3xl mx-auto p-6">
        <h1 className="font-display text-2xl font-bold text-brand mb-6">Frequently Asked Questions</h1>

        {SECTIONS.map(section => (
          <div key={section.title} className="mb-8">
            <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3 pb-2 border-b border-gray-200">
              {section.title}
            </h2>
            <div className="space-y-2">
              {section.items.map(item => (
                <details key={item.q} className="bg-white border border-gray-200 rounded-lg overflow-hidden group">
                  <summary className="px-4 py-3 font-medium cursor-pointer list-none flex justify-between items-center gap-3">
                    <span>{item.q}</span>
                    <span className="text-brand text-lg flex-shrink-0 group-open:rotate-45 transition-transform">+</span>
                  </summary>
                  <div className="px-4 pb-4 text-sm text-gray-700 leading-relaxed">{item.a}</div>
                </details>
              ))}
            </div>
          </div>
        ))}
      </div>
    </AppLayout>
  )
}
