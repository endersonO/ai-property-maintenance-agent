import { z } from "zod";

// Closed vocabularies at the LLM → code boundary. Mirrors the CHECK constraints in db/migrations.

export const Category = z.enum([
  "plumbing",
  "electrical",
  "heating",
  "appliance",
  "structural",
  "pest",
  "other",
]);
export type Category = z.infer<typeof Category>;

export const Hazard = z.enum([
  "active_water_leak",
  "gas_smell",
  "no_heating",
  "no_hot_water",
  "electrical_hazard",
  "security_risk",
]);
export type Hazard = z.infer<typeof Hazard>;

export const Priority = z.enum(["emergency", "high", "normal", "low"]);
export type Priority = z.infer<typeof Priority>;

export const TicketStatus = z.enum(["open", "in_progress", "resolved", "cancelled"]);
export type TicketStatus = z.infer<typeof TicketStatus>;
