-- get_my_service_managed_subscriptions() (added in 27_service_manager_cancel.sql)
-- backed a "Subscriptions you manage" section on the Approvals/Action Center
-- page that's since been removed — that page is now strictly "what do I need
-- to approve/decline/verify." Provisioning and cancellation (any status, any
-- license you manage) moved to Admin -> All Subscriptions instead, which is
-- now also open to service managers (see allowServiceManager on the
-- /admin/all-subscriptions route) and reads via the existing RLS-scoped
-- getAllSubscriptions() plain select — no dedicated RPC needed for that view.
-- cancel_subscription()'s broadened authorization (service managers can
-- cancel their licenses' subscriptions) is unaffected and stays as-is.

drop function if exists get_my_service_managed_subscriptions();
