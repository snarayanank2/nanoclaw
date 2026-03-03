/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3');
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// DB is only available to the main group (project root is mounted at /workspace/project)
const DB_PATH = '/workspace/project/store/messages.db';

function openDb(): InstanceType<typeof Database> | null {
  if (!isMain) return null;
  if (!fs.existsSync(DB_PATH)) return null;
  try {
    return new Database(DB_PATH, { readonly: true });
  } catch {
    return null;
  }
}

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'list_chats',
  "Search WhatsApp contacts and groups by name or JID. Use this to find a contact's JID before sending them a message. Main group only.",
  {
    query: z.string().optional().describe('Name or JID search (case-insensitive, partial match). Omit to list all.'),
    is_group: z.boolean().optional().describe('true=groups only, false=individuals only, omit=all'),
    limit: z.number().int().positive().default(20).describe('Max results to return'),
  },
  async (args) => {
    const db = openDb();
    if (!db) {
      return {
        content: [{ type: 'text' as const, text: 'list_chats is only available in the main group, and requires the messages DB to be accessible.' }],
        isError: true,
      };
    }

    try {
      const conditions: string[] = ["jid NOT LIKE '%__group_sync__%'"];
      const params: (string | number)[] = [];

      if (args.query) {
        conditions.push('(LOWER(name) LIKE LOWER(?) OR LOWER(jid) LIKE LOWER(?))');
        const q = `%${args.query}%`;
        params.push(q, q);
      }

      if (args.is_group === true) {
        conditions.push('is_group = 1');
      } else if (args.is_group === false) {
        conditions.push('is_group = 0');
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `SELECT jid, name, last_message_time, channel, is_group FROM chats ${where} ORDER BY last_message_time DESC LIMIT ?`;
      params.push(args.limit ?? 20);

      const rows = db.prepare(sql).all(...params) as Array<{
        jid: string; name: string; last_message_time: string; channel: string; is_group: number;
      }>;

      db.close();

      if (rows.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No chats found matching your query.' }] };
      }

      const formatted = rows.map(r =>
        `JID: ${r.jid}\nName: ${r.name || '(unknown)'}\nType: ${r.is_group ? 'Group' : 'Individual'}\nChannel: ${r.channel || 'whatsapp'}\nLast activity: ${r.last_message_time || 'unknown'}`
      ).join('\n---\n');

      return { content: [{ type: 'text' as const, text: `Found ${rows.length} chat(s):\n\n${formatted}` }] };
    } catch (err) {
      db.close();
      return {
        content: [{ type: 'text' as const, text: `Error querying chats: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'query_messages',
  'Read recent WhatsApp messages across all chats or filtered by a specific chat. Useful for summarizing recent activity, finding tasks, or checking conversations. Main group only.',
  {
    hours: z.number().positive().describe('How many hours back to look (e.g. 48 for last 48 hours)'),
    chat_jid: z.string().optional().describe("Filter to one specific chat — get the JID from list_chats first"),
    sender_name: z.string().optional().describe('Filter by sender name (partial, case-insensitive match)'),
    limit: z.number().int().positive().default(300).describe('Max messages to return'),
  },
  async (args) => {
    const db = openDb();
    if (!db) {
      return {
        content: [{ type: 'text' as const, text: 'query_messages is only available in the main group, and requires the messages DB to be accessible.' }],
        isError: true,
      };
    }

    try {
      const since = new Date(Date.now() - args.hours * 60 * 60 * 1000).toISOString();
      const conditions: string[] = ['m.timestamp > ?', "m.content != ''", 'm.content IS NOT NULL'];
      const params: (string | number)[] = [since];

      if (args.chat_jid) {
        conditions.push('m.chat_jid = ?');
        params.push(args.chat_jid);
      }

      if (args.sender_name) {
        conditions.push('LOWER(m.sender_name) LIKE LOWER(?)');
        params.push(`%${args.sender_name}%`);
      }

      const where = `WHERE ${conditions.join(' AND ')}`;
      const sql = `
        SELECT m.timestamp, m.sender_name, m.content, m.chat_jid, m.is_from_me, m.is_bot_message,
               c.name AS chat_name, c.is_group
        FROM messages m
        LEFT JOIN chats c ON c.jid = m.chat_jid
        ${where}
        ORDER BY m.timestamp ASC
        LIMIT ?
      `;
      params.push(args.limit ?? 300);

      const rows = db.prepare(sql).all(...params) as Array<{
        timestamp: string; sender_name: string; content: string; chat_jid: string;
        is_from_me: number; is_bot_message: number; chat_name: string | null; is_group: number;
      }>;

      db.close();

      if (rows.length === 0) {
        return { content: [{ type: 'text' as const, text: `No messages found in the last ${args.hours} hours.` }] };
      }

      const formatted = rows.map(r => {
        const chatLabel = r.chat_name || r.chat_jid;
        const chatType = r.is_group ? 'group' : 'DM';
        const who = r.is_from_me ? 'Me' : r.sender_name;
        const ts = new Date(r.timestamp).toLocaleString();
        return `[${ts}] ${chatLabel} (${chatType}) — ${who}: ${r.content}`;
      }).join('\n');

      return {
        content: [{ type: 'text' as const, text: `${rows.length} message(s) in the last ${args.hours}h:\n\n${formatted}` }],
      };
    } catch (err) {
      db.close();
      return {
        content: [{ type: 'text' as const, text: `Error querying messages: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'send_whatsapp_message',
  "Send a WhatsApp message to any contact or group. Use list_chats first to find the target JID. Main group only.",
  {
    target_jid: z.string().describe("WhatsApp JID of the recipient (e.g. '919876543210@s.whatsapp.net' or '120363...@g.us'). Get from list_chats."),
    text: z.string().describe('Message text to send'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'send_whatsapp_message is only available in the main group.' }],
        isError: true,
      };
    }

    const data = {
      type: 'message',
      chatJid: args.target_jid,
      text: args.text,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Message queued for delivery to ${args.target_jid}.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
