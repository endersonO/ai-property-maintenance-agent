import type { Evaluator } from "@/runtime/evaluation";
import { claimsMatchActions } from "./claims-match-actions";
import { emergencyReviewed } from "./emergency-reviewed";
import { hazardLogged } from "./hazard-logged";
import { noForeignIds } from "./no-foreign-ids";
import { numbersGrounded } from "./numbers-grounded";

// Horizontal evaluators: applied to every run, any workflow, any agency — online and in evals.
export const evaluators: Evaluator[] = [emergencyReviewed, noForeignIds, hazardLogged, claimsMatchActions, numbersGrounded];
