# Retained feature inventory

The local application and its data remain in `../src`, `../shared`, `../server` and `../.local-data`. The renderer and catalog/media components accept optional scoped adapters for the separate production entry. Their original preview behavior remains covered by the existing regression suite.

| Extra feature | Production migration status |
| --- | --- |
| Catalog library, uploads, saved generation and deletion | Production lists, designer, versions, background generation and archive connected. Uploaded PDFs require a configured scanner; permanent purge/recovery UI remains pending |
| Cover templates, gradients, logo size/position, fonts/colors, hidden fields | Existing designer connected to production save/draft APIs; worker shares its renderer |
| Image count, fit, zoom, position and shadows | Existing renderer reused by worker |
| Background removal and image editing | Existing browser tool uses scoped image reads and verified production uploads; original images retained |
| Multiple images, bulk selection, display/banner images | Production bulk upload, ordering and separate display/banner choices connected; database enforces gallery/image/space boundaries |
| Enquiry address and instant camera capture | Existing UI retained; structured address schema/API and private image intake implemented; camera flow connection pending |
| Direct and group messaging | Durable scoped spaces/messages, participants, provider edits and protected history implemented; realtime transport and UI connection pending |
| Private collector rooms | Tenant and room ACL foundations implemented; room product/offer presentation connection pending |
| Detailed admin/provider audit | Database triggers, restricted audit reads and durable provider evidence implemented; production Activity screen shows the latest 100 events and change details |
| Provider organizations, plans and employee limits | Verified provider access, plan/seat foundations and selected management endpoints implemented; console connection and full provider plan editor pending |
| Invoices and proforma invoices (PI) | Production editor, party addresses/GSTIN snapshots, issue/convert lifecycle, immutable issued documents, audit trail and print layout connected; payment-provider settlement and jurisdiction-specific tax integrations remain pending |
| Sales, offers, reservations and delivery | Existing preview retained; production schema established, remaining transactional business workflows pending |
| Trash, recovery, exports and backups | Resource archive/restore implemented; full tenant export/recovery and operational backups pending |
| Desktop and mobile layouts | Existing responsive interface retained; native Android/iOS/desktop installers remain out of scope |

Production migration retains the original 82 regression checks and adds 12 client transport checks and 48 backend checks. Browser verification exercised the catalog generation and bulk-image path through an explicitly enabled disposable test fixture. Never replace production sign-in with sample-profile selection or store tenant state as a JSON document.
