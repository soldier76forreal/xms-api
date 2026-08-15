// ============================================================================
// XMS — fresh-start RBAC seed + superAdmin grant
// Paste this ENTIRE script into MongoDB Compass's `MONGOSH` tab (bottom of the
// window, or View > Show MONGOSH), while connected to the TARGET database
// (the online/production one), then press Enter.
//
// What it does (all idempotent — safe to re-run):
//   1. Upserts the full 53-key permission catalog (matches the live backend's
//      requirePermission(...) checks exactly, verified against the current
//      route code before generating this script).
//   2. Upserts an 'Admin' role — isSuperAdmin:true (unlocks Roles/Groups/
//      Branches management) + every permission key (unlocks every
//      requirePermission(...) gate — the two axes are separate in this app,
//      see CLAUDE.md's Access Control section, so both are needed for real
//      'access to anything').
//   3. Looks up the two phone numbers below in the users collection and
//      upserts their userAccess doc with the Admin role — no hardcoded
//      ObjectIds, so this works on ANY database (dev/staging/prod) as long
//      as the users already exist there.
//
// Restart the api (xmsApi) process afterwards — permission checks are
// cached server-side for up to 60s per user, so a restart guarantees the
// change is picked up immediately instead of waiting out the cache.
// ============================================================================

const TARGET_PHONES = ['09918537814', '09308633322'];

const PERMISSIONS = [
  {
    "key": "inventory:view",
    "module": "inventory",
    "description": "View products and inventory"
  },
  {
    "key": "inventory:product:create",
    "module": "inventory",
    "description": "Create product"
  },
  {
    "key": "inventory:subproduct:create",
    "module": "inventory",
    "description": "Create sub-product (variant)"
  },
  {
    "key": "inventory:edit",
    "module": "inventory",
    "description": "Edit product descriptive info"
  },
  {
    "key": "inventory:delete",
    "module": "inventory",
    "description": "Delete product or variant"
  },
  {
    "key": "inventory:quantity:edit",
    "module": "inventory",
    "description": "Adjust stock quantity"
  },
  {
    "key": "inventory:price:edit",
    "module": "inventory",
    "description": "Change price"
  },
  {
    "key": "inventory:media:edit",
    "module": "inventory",
    "description": "Upload and delete media"
  },
  {
    "key": "users:view",
    "module": "users",
    "description": "View users list and details"
  },
  {
    "key": "users:create",
    "module": "users",
    "description": "Create user"
  },
  {
    "key": "users:edit",
    "module": "users",
    "description": "Edit user"
  },
  {
    "key": "users:delete",
    "module": "users",
    "description": "Delete user"
  },
  {
    "key": "users:unlock",
    "module": "users",
    "description": "Unlock a locked user account"
  },
  {
    "key": "users:role:view",
    "module": "users",
    "description": "View roles and permissions"
  },
  {
    "key": "users:role:edit",
    "module": "users",
    "description": "Create and edit roles"
  },
  {
    "key": "users:group:view",
    "module": "users",
    "description": "View groups"
  },
  {
    "key": "users:group:edit",
    "module": "users",
    "description": "Create and edit groups"
  },
  {
    "key": "crm:customer:view",
    "module": "crm",
    "description": ""
  },
  {
    "key": "crm:customer:create",
    "module": "crm",
    "description": "Create customer"
  },
  {
    "key": "crm:customer:edit",
    "module": "crm",
    "description": "Edit customer"
  },
  {
    "key": "crm:customer:delete",
    "module": "crm",
    "description": "Delete customer"
  },
  {
    "key": "mis:invoice:create",
    "module": "mis",
    "description": "Create invoice"
  },
  {
    "key": "mis:invoice:edit",
    "module": "mis",
    "description": "Edit invoice"
  },
  {
    "key": "mis:invoice:delete",
    "module": "mis",
    "description": "Delete invoice"
  },
  {
    "key": "files:view",
    "module": "files",
    "description": "View files"
  },
  {
    "key": "files:upload",
    "module": "files",
    "description": "Upload files"
  },
  {
    "key": "files:delete",
    "module": "files",
    "description": "Delete files"
  },
  {
    "key": "files:share",
    "module": "files",
    "description": "Share files"
  },
  {
    "key": "tasks:view",
    "module": "tasks",
    "description": "View tasks"
  },
  {
    "key": "tasks:create",
    "module": "tasks",
    "description": "Create and assign tasks"
  },
  {
    "key": "tasks:respond",
    "module": "tasks",
    "description": "Claim / complete tasks"
  },
  {
    "key": "crm:view",
    "module": "crm",
    "description": "View customers and CRM"
  },
  {
    "key": "crm:task:assign",
    "module": "crm",
    "description": "Assign customers to a user/group (My Desk)"
  },
  {
    "key": "crm:communication:view",
    "module": "crm",
    "description": "View communication history"
  },
  {
    "key": "crm:communication:create",
    "module": "crm",
    "description": "Log a call / note"
  },
  {
    "key": "mis:view",
    "module": "mis",
    "description": "View invoices and pre-invoices"
  },
  {
    "key": "mis:invoice:pdf",
    "module": "mis",
    "description": "Download invoice PDF"
  },
  {
    "key": "mis:preinvoice:create",
    "module": "mis",
    "description": "Create pre-invoice"
  },
  {
    "key": "mis:preinvoice:edit",
    "module": "mis",
    "description": "Edit pre-invoice"
  },
  {
    "key": "mis:preinvoice:delete",
    "module": "mis",
    "description": "Delete pre-invoice"
  },
  {
    "key": "mis:preinvoice:pdf",
    "module": "mis",
    "description": "Download pre-invoice PDF"
  },
  {
    "key": "mis:preinvoice:convert",
    "module": "mis",
    "description": "Convert pre-invoice to invoice"
  },
  {
    "key": "mis:payment:edit",
    "module": "mis",
    "description": "Record / edit invoice payment"
  },
  {
    "key": "mis:settings:edit",
    "module": "mis",
    "description": "Edit company settings (invoice header)"
  },
  {
    "key": "inventory:import",
    "module": "inventory",
    "description": "Import from Excel"
  },
  {
    "key": "inventory:export",
    "module": "inventory",
    "description": "Export inventory to Excel"
  },
  {
    "key": "digitalMarketing:view",
    "module": "digitalMarketing",
    "description": "View raw content and ready-to-upload content"
  },
  {
    "key": "digitalMarketing:rawContent:create",
    "module": "digitalMarketing",
    "description": "Upload a raw content batch"
  },
  {
    "key": "digitalMarketing:rawContent:edit",
    "module": "digitalMarketing",
    "description": "Edit / change status of raw content"
  },
  {
    "key": "digitalMarketing:rawContent:delete",
    "module": "digitalMarketing",
    "description": "Delete raw content"
  },
  {
    "key": "digitalMarketing:rawContent:chat",
    "module": "digitalMarketing",
    "description": "Chat on a raw content record"
  },
  {
    "key": "digitalMarketing:readyToUpload:edit",
    "module": "digitalMarketing",
    "description": "Edit ready-to-upload content"
  },
  {
    "key": "digitalMarketing:readyToUpload:delete",
    "module": "digitalMarketing",
    "description": "Delete ready-to-upload content"
  }
];

const ADMIN_PERMISSION_KEYS = [
  "inventory:view",
  "inventory:product:create",
  "inventory:subproduct:create",
  "inventory:edit",
  "inventory:delete",
  "inventory:quantity:edit",
  "inventory:price:edit",
  "inventory:media:edit",
  "inventory:import",
  "inventory:export",
  "users:view",
  "users:create",
  "users:edit",
  "users:delete",
  "users:unlock",
  "users:role:view",
  "users:role:edit",
  "users:group:view",
  "users:group:edit",
  "crm:view",
  "crm:customer:create",
  "crm:customer:edit",
  "crm:customer:delete",
  "crm:task:assign",
  "crm:communication:view",
  "crm:communication:create",
  "mis:view",
  "mis:invoice:create",
  "mis:invoice:edit",
  "mis:invoice:delete",
  "mis:invoice:pdf",
  "mis:preinvoice:create",
  "mis:preinvoice:edit",
  "mis:preinvoice:delete",
  "mis:preinvoice:pdf",
  "mis:preinvoice:convert",
  "mis:payment:edit",
  "mis:settings:edit",
  "files:view",
  "files:upload",
  "files:delete",
  "files:share",
  "tasks:view",
  "tasks:create",
  "tasks:respond",
  "digitalMarketing:view",
  "digitalMarketing:rawContent:create",
  "digitalMarketing:rawContent:edit",
  "digitalMarketing:rawContent:delete",
  "digitalMarketing:rawContent:chat",
  "digitalMarketing:readyToUpload:edit",
  "digitalMarketing:readyToUpload:delete"
];

// 1. Permission catalog
let permCount = 0;
PERMISSIONS.forEach((p) => {
  db.permissions.updateOne({ key: p.key }, { $set: p }, { upsert: true });
  permCount++;
});
print(`Seeded/verified ${permCount} permissions.`);

// 2. Admin role
db.roles.updateOne(
  { name: 'Admin' },
  {
    $set: {
      name: 'Admin',
      description: 'Full access to all sections',
      permissions: ADMIN_PERMISSION_KEYS,
      isSystem: true,
      isSuperAdmin: true,
      dataScopes: {},
      updateDate: new Date(),
    },
    $setOnInsert: { insertDate: new Date() },
  },
  { upsert: true }
);
const adminRole = db.roles.findOne({ name: 'Admin' });
print(`Admin role ready: _id=${adminRole._id}, ${adminRole.permissions.length} permissions, isSuperAdmin=${adminRole.isSuperAdmin}`);

// 3. Assign to the two target users
TARGET_PHONES.forEach((phone) => {
  const user = db.users.findOne({ phoneNumber: phone });
  if (!user) {
    print(`⚠ NOT FOUND: no user with phoneNumber ${phone} — skipped. Create the user first (they must sign up / be created once before you can grant access).`);
    return;
  }
  db.useraccesses.updateOne(
    { userId: user._id },
    {
      $set: {
        userId: user._id,
        roles: [adminRole._id],
        groups: [],
        grants: [],
        denies: [],
        updateDate: new Date(),
      },
      $setOnInsert: { insertDate: new Date(), branches: [] },
    },
    { upsert: true }
  );
  print(`✓ Admin role assigned to ${phone} (${user.firstName || ''} ${user.lastName || ''}, _id=${user._id})`);
});

print('Done. Restart the xmsApi server process now so the permission cache clears immediately.');
