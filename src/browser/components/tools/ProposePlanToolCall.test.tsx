import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { SendMessageOptions } from "@/common/orpc/types";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getAgentIdKey } from "@/common/constants/storage";

import { TooltipProvider } from "../ui/tooltip";

import { ProposePlanToolCall } from "./ProposePlanToolCall";

interface SendMessageArgs {
  workspaceId: string;
  message: string;
  options: SendMessageOptions;
}

type SendMessageResult = { success: true; data: undefined } | { success: false; error: string };

type GetPlanContentResult =
  | { success: true; data: { content: string; path: string } }
  | { success: false; error: string };

interface MockApi {
  workspace: {
    getPlanContent: () => Promise<GetPlanContentResult>;
    sendMessage: (args: SendMessageArgs) => Promise<SendMessageResult>;
    loop: Record<string, unknown>;
  };
}

let mockApi: MockApi | null = null;

let startHereCalls: Array<{
  workspaceId: string | undefined;
  content: string;
  isCompacted: boolean;
  options: { deletePlanFile?: boolean; sourceMode?: string } | undefined;
}> = [];

const useStartHereMock = mock(
  (
    workspaceId: string | undefined,
    content: string,
    isCompacted: boolean,
    options?: { deletePlanFile?: boolean; sourceMode?: string }
  ) => {
    startHereCalls.push({ workspaceId, content, isCompacted, options });
    return {
      openModal: () => undefined,
      isStartingHere: false,
      buttonLabel: "Start Here",
      buttonEmoji: "",
      disabled: false,
      modal: null,
    };
  }
);

void mock.module("@/browser/hooks/useStartHere", () => ({
  useStartHere: useStartHereMock,
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: mockApi, status: "connected" as const, error: null }),
}));

void mock.module("@/browser/hooks/useOpenInEditor", () => ({
  useOpenInEditor: () => () => Promise.resolve({ success: true } as const),
}));

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useOptionalWorkspaceContext: () => ({
    workspaceMetadata: new Map<string, { runtimeConfig?: unknown; name?: string }>(),
  }),
  useWorkspaceContext: () => ({
    workspaceMetadata: new Map<string, { runtimeConfig?: unknown; name?: string }>(),
  }),
}));

void mock.module("@/browser/contexts/TelemetryEnabledContext", () => ({
  useLinkSharingEnabled: () => true,
}));

describe("ProposePlanToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    startHereCalls = [];
    mockApi = null;
    // Save original globals
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    // Set up test globals
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    // Restore original globals instead of setting to undefined
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("keeps plan file on disk and includes plan path note in Start Here content", () => {
    const planPath = "~/.mux/plans/demo/ws-123.md";

    render(
      <TooltipProvider>
        <ProposePlanToolCall
          args={{}}
          result={{
            success: true,
            planPath,
            // Old-format chat history may include planContent; this is the easiest path to
            // ensure the rendered Start Here message includes the full plan + the path note.
            planContent: "# My Plan\n\nDo the thing.",
          }}
          workspaceId="ws-123"
          isLatest={false}
        />
      </TooltipProvider>
    );

    expect(startHereCalls.length).toBe(1);
    expect(startHereCalls[0]?.options).toEqual({ sourceMode: "plan" });
    expect(startHereCalls[0]?.isCompacted).toBe(false);

    // The Start Here message should explicitly tell the user the plan file remains on disk.
    expect(startHereCalls[0]?.content).toContain("*Plan file preserved at:*");
    expect(startHereCalls[0]?.content).toContain(planPath);
  });

  test("switches to exec and sends a message when clicking Implement", async () => {
    const workspaceId = "ws-123";
    const planPath = "~/.mux/plans/demo/ws-123.md";

    // Start in plan mode.
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));

    const sendMessageCalls: SendMessageArgs[] = [];

    mockApi = {
      workspace: {
        getPlanContent: () =>
          Promise.resolve({
            success: true,
            data: { content: "# My Plan\n\nDo the thing.", path: planPath },
          }),
        loop: {
          startFromPlan: () => Promise.resolve({ success: true, data: undefined }),
        },
        sendMessage: (args: SendMessageArgs) => {
          sendMessageCalls.push(args);
          return Promise.resolve({ success: true, data: undefined });
        },
      },
    };

    const view = render(
      <TooltipProvider>
        <ProposePlanToolCall
          args={{}}
          status="completed"
          result={{
            success: true,
            planPath,
            planContent: "# My Plan\n\nDo the thing.",
          }}
          workspaceId={workspaceId}
          isLatest={true}
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.message).toBe("Implement the plan");
    // Clicking Implement should switch the workspace agent to exec.
    //
    // Note: some tests in this repo mock the `usePersistedState` module globally. In that case,
    // `updatePersistedState` won't actually write to localStorage here, so we assert the call.
    const agentKey = getAgentIdKey(workspaceId);
    const updatePersistedStateMaybeMock = updatePersistedState as unknown as {
      mock?: { calls: unknown[][] };
    };
    if (updatePersistedStateMaybeMock.mock) {
      expect(updatePersistedState).toHaveBeenCalledWith(agentKey, "exec");
    } else {
      expect(JSON.parse(window.localStorage.getItem(agentKey)!)).toBe("exec");
    }
  });

  test("switches to harness-init and sends a harness proposal request when clicking Start Ralph loop", async () => {
    const workspaceId = "ws-123";
    const planPath = "~/.mux/plans/demo/ws-123.md";

    // Start in plan mode.
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));

    const sendMessageCalls: SendMessageArgs[] = [];

    let resolveSendMessage!: (value: SendMessageResult) => void;
    const sendMessagePromise = new Promise<SendMessageResult>((resolve) => {
      resolveSendMessage = resolve;
    });

    mockApi = {
      workspace: {
        getPlanContent: () =>
          Promise.resolve({
            success: true,
            data: { content: "# My Plan\n\nDo the thing.", path: planPath },
          }),
        sendMessage: (args: SendMessageArgs) => {
          sendMessageCalls.push(args);
          return sendMessagePromise;
        },
        loop: {},
      },
    };

    const view = render(
      <TooltipProvider>
        <ProposePlanToolCall
          args={{}}
          status="completed"
          result={{
            success: true,
            planPath,
            planContent: "# My Plan\n\nDo the thing.",
          }}
          workspaceId={workspaceId}
          isLatest={true}
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Start Ralph loop" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.message).toBe(
      "Generate a Ralph harness from the current plan and propose it"
    );

    await waitFor(() => {
      const button = view.getByRole("button", { name: "Start Ralph loop" }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    resolveSendMessage({ success: true, data: undefined });

    await waitFor(() => {
      const button = view.getByRole("button", { name: "Start Ralph loop" }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });

    const agentKey = getAgentIdKey(workspaceId);
    const updatePersistedStateMaybeMock = updatePersistedState as unknown as {
      mock?: { calls: unknown[][] };
    };
    if (updatePersistedStateMaybeMock.mock) {
      expect(updatePersistedState).toHaveBeenCalledWith(agentKey, "harness-init");
    } else {
      expect(JSON.parse(window.localStorage.getItem(agentKey)!)).toBe("harness-init");
    }
  });
});
