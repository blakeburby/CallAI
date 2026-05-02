export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "create_task",
      description:
        "Create a remote developer-operator task from the user's spoken request. Use this for repo inspection, edits, tests, Codex delegation, docs updates, bug fixes, project work, and local Mac computer control through Blake's bridge, including Atlas/browser work, Finder, visible apps, screenshots, safe shell commands, navigation, searching, clicking, typing, and routine non-sensitive form filling.",
      parameters: {
        type: "object",
        properties: {
          utterance: {
            type: "string",
            description:
              "The user's full natural-language request, preserving repo/project hints and acceptance details."
          },
          session_id: {
            type: "string",
            description: "Optional CallAI voice session identifier."
          },
          repo_hint: {
            type: "string",
            description:
              "Optional repo or project hint, such as main repo, dashboard repo, or owner/name."
          }
        },
        required: ["utterance"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_task_status",
      description:
        "Get the current status, latest audit events, confirmations, and final summary for a developer task.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The CallAI task id."
          }
        },
        required: ["task_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "continue_task",
      description:
        "Continue, retry, or add instructions to an existing developer task that is blocked, failed, or waiting.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The CallAI task id."
          },
          instructions: {
            type: "string",
            description: "Optional additional instructions from the user."
          }
        },
        required: ["task_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "approve_action",
      description:
        "Approve or deny a pending confirmation request for a risky or externally visible action.",
      parameters: {
        type: "object",
        properties: {
          confirmation_id: {
            type: "string",
            description: "The confirmation request id."
          },
          decision: {
            type: "string",
            enum: ["approved", "denied"],
            description: "Whether the user approved or denied the action."
          }
        },
        required: ["confirmation_id", "decision"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cancel_task",
      description: "Cancel an existing developer task.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The CallAI task id."
          },
          reason: {
            type: "string",
            description: "Optional reason for cancellation."
          }
        },
        required: ["task_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_project_update",
      description:
        "Record or send a concise project update to a configured chat/project channel.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Optional related CallAI task id."
          },
          channel_hint: {
            type: "string",
            description: "Optional channel hint, such as project chat or Slack channel."
          },
          message: {
            type: "string",
            description: "The project update to send or record."
          }
        },
        required: ["message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "start_outbound_call",
      description:
        "Start an outbound phone call through Vapi for a task update or follow-up.",
      parameters: {
        type: "object",
        properties: {
          phone_number: {
            type: "string",
            description: "The E.164 phone number to call, such as +15551234567."
          },
          reason: {
            type: "string",
            description: "Why CallAI is placing the call."
          },
          task_id: {
            type: "string",
            description: "Optional related task id."
          }
        },
        required: ["phone_number", "reason"]
      }
    }
  }
] as const;

export default toolDefinitions;
