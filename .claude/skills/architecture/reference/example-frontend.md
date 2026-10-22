```
project-management-tool/
├── apps/
│   ├── web/
│   │   └── src/
│   │       ├── domains/
│   │       │   ├── projects/
│   │       │   │   ├── components/      ← ProjectCard, ProjectList, ProjectHeader
│   │       │   │   ├── hooks/           ← useProject, useProjectMembers
│   │       │   │   ├── api.ts           ← typed calls to /projects endpoints
│   │       │   │   ├── types.ts         ← Project, ProjectStatus, ProjectMember
│   │       │   │   └── index.ts         ← barrel
│   │       │   ├── tasks/
│   │       │   │   ├── components/      ← TaskCard, TaskList, TaskBoard, TaskDetail
│   │       │   │   ├── hooks/           ← useTask, useTaskFilters
│   │       │   │   ├── api.ts
│   │       │   │   ├── types.ts
│   │       │   │   └── index.ts
│   │       │   ├── teams/
│   │       │   ├── sprints/
│   │       │   └── comments/
│   │       ├── ui/                      ← shared visual primitives
│   │       │   ├── Button.tsx
│   │       │   ├── Input.tsx
│   │       │   ├── Modal.tsx
│   │       │   ├── Card.tsx
│   │       │   ├── Tabs.tsx
│   │       │   ├── Tooltip.tsx
│   │       │   └── index.ts
│   │       ├── app/                     ← Next.js routing (thin)
│   │       │   ├── projects/
│   │       │   │   ├── [id]/
│   │       │   │   │   └── page.tsx     ← imports from domains/projects
│   │       │   │   └── page.tsx
│   │       │   ├── tasks/
│   │       │   │   └── [id]/
│   │       │   │       └── page.tsx
│   │       │   ├── layout.tsx
│   │       │   └── page.tsx
│   │       ├── lib/                     ← non-visual utilities
│   │       │   ├── api-client.ts
│   │       │   ├── format-date.ts
│   │       │   └── analytics.ts
│   │       ├── hooks/                   ← shared cross-domain hooks
│   │       │   ├── useDebounce.ts
│   │       │   └── useLocalStorage.ts
│   │       └── types/                   ← cross-domain types
│   │           ├── api.ts
│   │           └── user.ts
│   │
│   ├── api/
│   │   └── src/
│   │       ├── domains/
│   │       │   ├── projects/
│   │       │   │   ├── create-project.ts        ← verb-noun operation
│   │       │   │   ├── update-project.ts
│   │       │   │   ├── archive-project.ts
│   │       │   │   ├── list-projects.ts
│   │       │   │   ├── project-repository.ts    ← noun: data access
│   │       │   │   ├── project-validator.ts     ← noun: validation
│   │       │   │   ├── routes.ts                ← HTTP route registration
│   │       │   │   ├── schemas.ts               ← Zod boundary schemas
│   │       │   │   ├── types.ts                 ← Project, ProjectStatus
│   │       │   │   └── index.ts
│   │       │   ├── tasks/
│   │       │   │   ├── create-task.ts
│   │       │   │   ├── assign-task.ts
│   │       │   │   ├── complete-task.ts
│   │       │   │   ├── reorder-tasks.ts
│   │       │   │   ├── task-repository.ts
│   │       │   │   ├── routes.ts
│   │       │   │   ├── schemas.ts
│   │       │   │   ├── types.ts
│   │       │   │   └── index.ts
│   │       │   ├── teams/
│   │       │   ├── sprints/
│   │       │   └── comments/
│   │       ├── auth/                    ← cross-cutting infrastructure
│   │       │   ├── verify-token.ts
│   │       │   ├── require-auth.ts      ← middleware
│   │       │   ├── permissions.ts       ← noun: permission table
│   │       │   └── types.ts
│   │       ├── db/
│   │       │   ├── client.ts            ← database connection
│   │       │   ├── migrations/
│   │       │   └── schema.prisma
│   │       ├── queue/
│   │       │   ├── client.ts
│   │       │   ├── enqueue-job.ts
│   │       │   └── types.ts
│   │       ├── lib/
│   │       │   ├── logger.ts
│   │       │   ├── config.ts
│   │       │   └── errors.ts
│   │       ├── types/
│   │       │   └── api.ts
│   │       └── index.ts                 ← composition root
│   │
│   ├── worker/                          ← background jobs / queue consumers
│   └── admin/                           ← internal admin tool (optional)
│
├── packages/                            ← shared libraries across apps
│   ├── domain-types/                    ← types shared between web and api
│   ├── api-client/                      ← typed client web uses to call api
│   ├── ui/                              ← shared design system components
│   └── config/                          ← shared eslint, tsconfig, etc.
│
├── infra/                               ← deployment, IaC, docker
├── docs/
│   ├── architecture.md
│   └── decisions/                       ← ADR log
├── scripts/
└── .workflow/                           ← agentic workflow system
    ├── README.md
    ├── entry_prompt.md
    ├── principles.yaml
    ├── classifications.yaml
    ├── workflows.yaml
    ├── active_workflow.yaml
    ├── codebase_notes.yaml
    └── workflow_feedback.yaml
```