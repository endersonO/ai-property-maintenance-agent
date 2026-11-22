import type { Repository } from "@/domain/repository";

// Dependencies shared by every workflow's tools.
export type AppDeps = { repo: Repository };
