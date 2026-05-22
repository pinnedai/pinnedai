# Lock down /api/admin/export

Customer reported the admin export endpoint was returning data without an Authorization header. The middleware was checking auth on the parent route but the export subroute had its own handler that bypassed it.

Auth required on /api/admin/export.

Wired the check into the route handler directly. Same pattern as the rest of the admin/* endpoints.
