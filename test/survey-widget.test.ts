// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderSurveyWidget } from "../src/survey-widget";
import type { SurveyData } from "../src/types";

describe("renderSurveyWidget session meta", () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: "resp-1", status: "complete" }) }));

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    document.body.innerHTML = "";
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes meta.session_id and meta.user_id on submit", async () => {
    const survey: SurveyData = {
      id: "survey-1",
      name: "Exit survey",
      questions: [
        {
          id: "q1",
          type: "freeText",
          label: "What stopped you?",
        },
      ],
      styling: {},
    };

    renderSurveyWidget(survey, "https://api.example.com", "user-abc", "team-1", new Set(), "sess-xyz");

    const host = document.getElementById("growth-surveys-widget");
    expect(host).toBeTruthy();
    const shadow = host!.shadowRoot!;
    const input = shadow.querySelector("input[data-qid='q1']") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = "Pricing was confusing for our team size";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const submit = shadow.querySelector('[data-action="next"]') as HTMLButtonElement;
    submit.click();

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/respond"))).toBe(true);
    });

    const respondCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/respond"));
    expect(respondCall).toBeTruthy();
    const init = respondCall![1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      meta: Record<string, unknown>;
      respondentId?: string;
    };
    expect(body.meta.session_id).toBe("sess-xyz");
    expect(body.meta.user_id).toBe("user-abc");
    expect(body.respondentId).toBe("user-abc");
  });

  it("posts a view ping once when the widget is shown", () => {
    const survey: SurveyData = {
      id: "survey-views",
      name: "On-site survey",
      questions: [{ id: "q1", type: "freeText", label: "Why?" }],
      styling: {},
    };

    renderSurveyWidget(survey, "https://api.example.com", null, "team-1", new Set());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/api/public/surveys/survey-views/view");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("does not post a view ping when the survey was already shown this session", () => {
    const survey: SurveyData = {
      id: "survey-already-shown",
      name: "On-site survey",
      questions: [{ id: "q1", type: "freeText", label: "Why?" }],
      styling: {},
    };

    renderSurveyWidget(survey, "https://api.example.com", null, "team-1", new Set(["survey-already-shown"]));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.getElementById("growth-surveys-widget")).toBeNull();
  });
});
