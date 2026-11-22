import { maintenanceWorkflow } from "./maintenance";
import { ticketStatusWorkflow } from "./ticket-status";

// Workflow registry: adding a workflow means adding an entry here, not changing the runtime.
export const workflows = {
  maintenance: maintenanceWorkflow,
  "ticket-status": ticketStatusWorkflow,
};

export type WorkflowId = keyof typeof workflows;
export const workflowIds = Object.keys(workflows) as [WorkflowId, ...WorkflowId[]];
