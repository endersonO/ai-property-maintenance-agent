import type { Evaluator } from "@/runtime/evaluation";
import { emergencyReviewed } from "./emergency-reviewed";
import { hazardLogged } from "./hazard-logged";

// Horizontal evaluators: applied to every run, any workflow, any agency — online and in evals.
export const evaluators: Evaluator[] = [emergencyReviewed, hazardLogged];
