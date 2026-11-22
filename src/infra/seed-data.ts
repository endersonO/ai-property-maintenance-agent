import { Policy } from "@/domain/policy";

// Same synthetic data as db/seed.sql, for the in-memory repository used by evals.
// Keep both in sync; the Postgres integration tests compare them.

// Lifecycle dates (ISO) only for agencies joined by acquisition.
export type AgencySeed = {
  id: string;
  name: string;
  acquiredOn: string | null;
  historyStartsOn: string | null;
  onboardedOn: string | null;
};

export const agencies: AgencySeed[] = [
  { id: "agency_northbridge", name: "Northbridge Lettings", acquiredOn: null, historyStartsOn: null, onboardedOn: null },
  { id: "agency_harbour_lane", name: "Harbour Lane Estates", acquiredOn: null, historyStartsOn: null, onboardedOn: null },
  {
    id: "agency_riverside",
    name: "Riverside Homes",
    acquiredOn: "2026-03-01",
    historyStartsOn: "2026-03-01",
    onboardedOn: "2026-06-01",
  },
];

export const policies = [
  {
    agencyId: "agency_northbridge",
    version: 1,
    policy: Policy.parse({
      rules: [
        {
          if: { hazardsAny: ["gas_smell", "active_water_leak", "electrical_hazard"] },
          priority: "emergency",
          forceReview: true,
        },
        { if: { category: "heating", hazardsAny: ["no_heating"] }, priority: "high" },
        { if: { hazardsAny: ["security_risk"] }, priority: "high" },
      ],
      defaultPriority: "normal",
      costEstimatesGbp: { plumbing: 180, electrical: 300, heating: 400, appliance: 120 },
      defaultCostEstimateGbp: 150,
      reviewAboveGbp: 250,
    }),
  },
  {
    agencyId: "agency_harbour_lane",
    version: 1,
    policy: Policy.parse({
      rules: [
        {
          if: { hazardsAny: ["gas_smell", "active_water_leak", "electrical_hazard"] },
          priority: "emergency",
          forceReview: true,
        },
        {
          if: { hazardsAny: ["no_heating", "no_hot_water", "security_risk"] },
          priority: "high",
        },
      ],
      defaultPriority: "normal",
      costEstimatesGbp: { plumbing: 220, electrical: 350, heating: 450, appliance: 150 },
      defaultCostEstimateGbp: 180,
      reviewAboveGbp: 0,
    }),
  },
  {
    agencyId: "agency_riverside",
    version: 1,
    policy: Policy.parse({
      rules: [
        { if: { hazardsAny: ["gas_smell", "electrical_hazard"] }, priority: "emergency", forceReview: true },
        { if: { hazardsAny: ["active_water_leak", "no_heating"] }, priority: "high" },
      ],
      defaultPriority: "normal",
      costEstimatesGbp: { plumbing: 160, electrical: 280, heating: 380, appliance: 110 },
      defaultCostEstimateGbp: 140,
      reviewAboveGbp: 300,
    }),
  },
];

export const properties = [
  { id: "prop_mcr_1", agencyId: "agency_northbridge", address: "Flat 4, 18 Mill Lane", city: "Manchester", postcode: "M4 6AB" },
  { id: "prop_lds_1", agencyId: "agency_northbridge", address: "27 Kirkgate Row", city: "Leeds", postcode: "LS2 7DJ" },
  { id: "prop_bri_1", agencyId: "agency_harbour_lane", address: "Flat 2, 9 Quayside Court", city: "Bristol", postcode: "BS1 4RT" },
];

export const tenants = [
  { id: "tenant_olivia", name: "Olivia Bennett", email: "olivia.bennett@example.com", propertyId: "prop_mcr_1" },
  { id: "tenant_james", name: "James Okafor", email: "james.okafor@example.com", propertyId: "prop_lds_1" },
  { id: "tenant_priya", name: "Priya Shah", email: "priya.shah@example.com", propertyId: "prop_bri_1" },
];

export const managers = [
  { id: "manager_north", name: "Alex Morgan (North region)", agencyIds: ["agency_northbridge", "agency_riverside"] },
  {
    id: "manager_ops",
    name: "Sam Taylor (Operations director)",
    agencyIds: ["agency_harbour_lane", "agency_northbridge", "agency_riverside"],
  },
];
