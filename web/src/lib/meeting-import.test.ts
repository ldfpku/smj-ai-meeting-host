// Run with: node --test web/src/lib/meeting-import.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildImportInstruction,
  ImportError,
  matchDepartment,
  matchRole,
  MAX_IMPORT_CHARS,
  normalizeImport,
  prepareDocumentText,
} from "./meeting-import.ts";
import {
  SMJ_DEPARTMENTS,
  SMJ_PROCESSES,
  SMJ_ROLES,
} from "../data/smj-org.ts";

const vocabulary = {
  departments: SMJ_DEPARTMENTS.map((d) => d.name),
  roles: SMJ_ROLES,
  processes: SMJ_PROCESSES.map((p) => ({ id: p.id, name: p.name })),
};

const agenda = (over: Record<string, unknown> = {}) => ({
  title: "瓶颈工序",
  durationMinutes: 15,
  goal: "确定疏通措施",
  presenter: "",
  preReadRef: "",
  processId: "",
  ...over,
});

test("a department is found by its full name or by its short name", () => {
  const find = (v: string) => matchDepartment(v, vocabulary.departments);
  assert.equal(find("生产制造部"), "生产制造部");
  assert.equal(find("生产部"), "生产制造部");
  assert.equal(find("质量部"), "质量安全部");
  assert.equal(find(" 财务 部 "), "财务部");
  assert.equal(find("SMJ 供应链部采购组"), "供应链部");
  assert.equal(find("数字化办公室"), undefined);
  assert.equal(find(""), undefined);
});

test("a role is completed with its department", () => {
  const find = (v: string, dept?: string) =>
    matchRole(v, dept, vocabulary.roles)?.title;
  assert.equal(find("部长", "生产制造部"), "生产制造部部长");
  assert.equal(find("部长", "财务部"), "财务部长");
  assert.equal(find("财务部部长"), "财务部长");
  assert.equal(find("质量部部长"), "质量安全部部长");
  assert.equal(find("生产制造部 部长", "生产制造部"), "生产制造部部长");
  assert.equal(find("车间主任"), "车间主任");
  assert.equal(find("数据分析师", "财务部"), undefined);
});

test("what the document says is kept, what the company does not know is reported", () => {
  const { meeting, warnings } = normalizeImport(
    {
      topic: " 螺杆交付专题会 ",
      meetingType: "专题会",
      chair: "王强",
      statedTotalMinutes: 35,
      requirePreRead: true,
      escalationPath: "提请总经理签批",
      style: "",
      attendees: [
        { name: "王强", dept: "生产部", role: "部长", required: true },
        { name: "刘洋", dept: "财务部", role: "部长", required: false },
        { name: "吴桐", dept: "数字化办公室", role: "数据分析师", required: false },
        { name: "王强", dept: "生产制造部", role: "部长", required: true },
        { name: "", dept: "", role: "", required: true },
      ],
      agendas: [
        agenda({ title: "1. 瓶颈工序", durationMinutes: "20 分钟", presenter: "王强" }),
        agenda({ title: "二、长周期棒料采购", processId: "s-01", preReadRef: "订货清单" }),
      ],
    },
    vocabulary
  );

  assert.equal(meeting.topic, "螺杆交付专题会");
  assert.equal(meeting.chair, "生产制造部部长");
  assert.equal(meeting.requirePreRead, true);
  assert.equal(meeting.style, undefined);
  assert.deepEqual(
    meeting.attendees.map((a) => [a.name, a.dept, a.role, a.required]),
    [
      ["王强", "生产制造部", "生产制造部部长", true],
      ["刘洋", "财务部", "财务部长", false],
      ["吴桐", "数字化办公室", "数据分析师", false],
    ]
  );
  assert.deepEqual(
    meeting.agendas.map((a) => [a.id, a.title, a.durationMinutes, a.processId]),
    [
      ["agenda-import-1", "瓶颈工序", 20, undefined],
      ["agenda-import-2", "长周期棒料采购", 15, "S-01"],
    ]
  );
  assert.equal(meeting.agendas[0].presenter, "王强");
  assert.equal(meeting.agendas[1].preReadRef, "订货清单");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /数字化办公室/);
  assert.match(warnings[1], /数据分析师/);
});

test("an agenda without a duration gets its share of the stated length", () => {
  const { meeting, warnings } = normalizeImport(
    {
      topic: "质量例会",
      statedTotalMinutes: 60,
      agendas: [
        agenda({ title: "复查结果", durationMinutes: null, goal: "" }),
        agenda({ title: "8D 进展", durationMinutes: null }),
        agenda({ title: "外审准备", durationMinutes: 0 }),
      ],
    },
    vocabulary
  );
  assert.deepEqual(
    meeting.agendas.map((a) => a.durationMinutes),
    [20, 20, 20]
  );
  assert.match(warnings[0], /总时长 60 分钟/);
  assert.match(warnings[1], /没有写目标.*复查结果/);
  assert.match(warnings[2], /没有找到参会人/);
});

test("without a stated length the usual ten minutes are used and said", () => {
  const { meeting, warnings } = normalizeImport(
    {
      topic: "周会",
      agendas: [
        agenda({ durationMinutes: 25 }),
        agenda({ title: "其他", durationMinutes: "" }),
      ],
    },
    vocabulary
  );
  assert.deepEqual(
    meeting.agendas.map((a) => a.durationMinutes),
    [25, 10]
  );
  assert.match(warnings[0], /先按 10 分钟填写：其他/);
});

test("a stated length that differs from the sum is pointed out", () => {
  const { warnings } = normalizeImport(
    {
      topic: "周会",
      statedTotalMinutes: 90,
      attendees: [{ name: "王强", dept: "", role: "车间主任" }],
      agendas: [agenda({ durationMinutes: 20 }), agenda({ title: "其他" })],
    },
    vocabulary
  );
  assert.deepEqual(warnings, [
    "文档写的会议总时长是 90 分钟，各议题用时合计 35 分钟，两者不一致。",
  ]);
});

test("values outside the standard format are dropped or limited", () => {
  const { meeting, warnings } = normalizeImport(
    {
      topic: "周会",
      style: "aggressive",
      requirePreRead: "也许",
      attendees: [{ name: "", dept: "", role: "车间主任", required: "否" }],
      agendas: [
        agenda({ durationMinutes: 999, processId: "X-99" }),
        { title: "", durationMinutes: 10 },
        "不是对象",
      ],
    },
    vocabulary
  );
  assert.equal(meeting.style, undefined);
  assert.equal(meeting.requirePreRead, undefined);
  assert.equal(meeting.agendas.length, 1);
  assert.equal(meeting.agendas[0].durationMinutes, 180);
  assert.equal(meeting.agendas[0].processId, undefined);
  assert.deepEqual(meeting.attendees[0], {
    id: "att-import-1",
    name: "",
    dept: "生产制造部",
    role: "车间主任",
    required: false,
  });
  assert.match(warnings.join("\n"), /X-99/);
});

test("a document without agenda items is refused", () => {
  assert.throws(
    () => normalizeImport({ topic: "通知", agendas: [] }, vocabulary),
    ImportError
  );
  assert.throws(() => normalizeImport(null, vocabulary), ImportError);
});

test("the text is tidied and cut at the limit", () => {
  assert.deepEqual(prepareDocumentText("a  \r\n\r\n\r\n\r\nb c\n"), {
    text: "a\n\nb c",
    truncated: false,
  });
  const long = prepareDocumentText("字".repeat(MAX_IMPORT_CHARS + 5));
  assert.equal(long.text.length, MAX_IMPORT_CHARS);
  assert.equal(long.truncated, true);
});

test("the instruction names the lists of the company", () => {
  const instruction = buildImportInstruction(vocabulary);
  assert.match(instruction, /质量安全部/);
  assert.match(instruction, /售后质量工程师/);
  assert.match(instruction, /Q-03 失效分析/);
});
