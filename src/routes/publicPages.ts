import { Router } from "express";

export const publicPagesRouter = Router();

publicPagesRouter.get("/sms-opt-in", (_request, response) => {
  response.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CallAI SMS Control</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #15171d;
        --muted: #626776;
        --line: #d8dce6;
        --panel: #f6f7fb;
        --accent: #2457ff;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
        color: var(--ink);
        background: #ffffff;
        line-height: 1.5;
      }

      main {
        width: min(880px, calc(100% - 32px));
        margin: 0 auto;
        padding: 56px 0 72px;
      }

      h1 {
        margin: 0 0 12px;
        font-size: clamp(34px, 6vw, 56px);
        line-height: 1;
        letter-spacing: 0;
      }

      h2 {
        margin: 34px 0 10px;
        font-size: 22px;
      }

      p,
      li {
        font-size: 17px;
      }

      p {
        margin: 0 0 14px;
      }

      ul {
        padding-left: 22px;
      }

      code {
        padding: 2px 6px;
        border-radius: 6px;
        background: var(--panel);
        font-size: 0.95em;
      }

      .hero {
        padding-bottom: 28px;
        border-bottom: 1px solid var(--line);
      }

      .eyebrow {
        margin: 0 0 18px;
        color: var(--accent);
        font-weight: 700;
        text-transform: uppercase;
        font-size: 13px;
        letter-spacing: 0.08em;
      }

      .panel {
        margin-top: 20px;
        padding: 18px 20px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
      }

      .muted {
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="eyebrow">CallAI SMS Control</p>
        <h1>Text Jarvis to control CallAI.</h1>
        <p>
          CallAI is a private developer-operator assistant. Authorized users can
          text Jarvis to chat, create coding tasks, control the local Mac bridge,
          check task status, and approve pending actions.
        </p>
        <div class="panel">
          <p>
            By texting <code>HELLO</code>, <code>START</code>,
            <code>STATUS</code>, or a task request to
            <strong>+1 833-550-5290</strong>, you consent to receive SMS
            messages from CallAI/Jarvis about chat replies, task status,
            approvals, and completion updates.
          </p>
          <p>
            Message frequency varies. Message and data rates may apply. Reply
            <code>STOP</code> to opt out. Reply <code>HELP</code> for help.
          </p>
        </div>
        <p class="muted">
          This page explains the SMS program used for CallAI account verification
          and toll-free messaging compliance.
        </p>
      </section>

      <section>
        <h2>How Opt-In Works</h2>
        <p>
          Users opt in by directly texting the CallAI SMS number and requesting
          Jarvis assistance. The service is intended for private account control,
          not marketing broadcasts.
        </p>
        <p>
          Example opt-in message: <code>hello</code> or
          <code>inspect the main repo</code>.
        </p>
        <p>
          CallAI does not send marketing broadcasts. SMS is used for private
          account-control and developer-operator task updates.
        </p>
      </section>

      <section>
        <h2>Message Types</h2>
        <ul>
          <li>Conversational replies, such as help and status responses.</li>
          <li>Task acknowledgements when coding, project, or local Mac work is queued.</li>
          <li>Progress, completion, blocked, or failure notifications.</li>
          <li>Confirmation prompts before sensitive actions such as external sends, file deletion, settings changes, commit, push, deploy, or secret changes.</li>
        </ul>
      </section>

      <section>
        <h2>Example Messages</h2>
        <div class="panel">
          <p><strong>User:</strong> hello</p>
          <p><strong>Jarvis:</strong> Online. I can chat, queue repo work, use the Mac local bridge, check status, and handle approvals.</p>
          <p><strong>User:</strong> inspect the main repo</p>
          <p><strong>Jarvis:</strong> Queued task 123456. I'll report back when it finishes.</p>
          <p><strong>Jarvis:</strong> Task 123456 needs approval before commit or push. Reply approve 123456 or deny 123456.</p>
          <p><strong>Jarvis:</strong> Task 123456 completed. Summary: inspected the repo and found no blocking issues.</p>
        </div>
      </section>

      <section>
        <h2>Help And Opt-Out</h2>
        <p>
          Text <code>HELP</code> for support instructions. Text
          <code>STOP</code> to stop receiving SMS messages. Standard message and
          data rates may apply.
        </p>
      </section>

      <section>
        <h2>Privacy</h2>
        <p>
          CallAI stores SMS content, task status, and audit events only to operate
          the requested assistant workflow. It does not sell SMS data or use SMS
          conversations for third-party marketing.
        </p>
        <p>
          Sensitive values such as API keys, passwords, and tokens are not sent
          in SMS replies.
        </p>
      </section>
    </main>
  </body>
</html>`);
});
