import { maintenanceWorkflow } from "./maintenance";

// Workflow registry: adding a workflow means adding an entry here, not changing the runtime.
export const workflows = {
  maintenance: maintenanceWorkflow,
};

export type WorkflowId = keyof typeof workflows;
