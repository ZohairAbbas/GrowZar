/** Contact kinds, shared by the server and the screens. */

export const CONTACT_KINDS = ["supplier", "customer", "courier", "gateway", "ad_platform", "tax_office", "other"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export const CONTACT_KIND_LABELS: Record<ContactKind, string> = {
  supplier: "Supplier",
  customer: "Customer",
  courier: "Courier",
  gateway: "Payment gateway",
  ad_platform: "Ad platform",
  tax_office: "Tax office",
  other: "Other",
};
