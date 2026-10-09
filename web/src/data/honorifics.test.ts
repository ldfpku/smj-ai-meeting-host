// Run with: node --test web/src/data/honorifics.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { callNameFor, surnameOf, titleSuffix, withCallNames } from "./honorifics.ts";

test("a name and a post make 李总, 王部长, 赵主管", () => {
  assert.equal(callNameFor("李建国", "总经理"), "李总");
  assert.equal(callNameFor("李建国", "副总经理"), "李总");
  assert.equal(callNameFor("王芳", "生产制造部部长"), "王部长");
  assert.equal(callNameFor("赵强", "维保基地主管"), "赵主管");
  assert.equal(callNameFor("孙伟", "工艺工程师"), "孙工");
});

test("compound surnames are kept whole", () => {
  assert.equal(surnameOf("欧阳明"), "欧阳");
  assert.equal(callNameFor("欧阳明", "质量安全部部长"), "欧阳部长");
  assert.equal(surnameOf("张三"), "张");
});

test("without a name the post is used, without a known post the name", () => {
  assert.equal(callNameFor("", "生产制造部部长"), "生产制造部部长");
  assert.equal(callNameFor("张三", "生产计划员"), "张三");
  assert.equal(callNameFor("张三", ""), "张三");
  assert.equal(callNameFor("", ""), "");
  // a one-character name gives no surname to build 李总 from
  assert.equal(callNameFor("李", "总经理"), "李");
});

test("assistants and secretaries are not called 总 or 部长", () => {
  assert.equal(titleSuffix("总经理助理"), null);
  assert.equal(callNameFor("周萍", "部长秘书"), "周萍");
});

test("the config gets call names for the chair and every attendee", () => {
  const config = withCallNames({
    chair: "总经理",
    chairName: "李建国",
    attendees: [
      { name: "王芳", role: "生产制造部部长" },
      { name: "", role: "供应链部部长" },
    ],
  });
  assert.equal(config.chairCallName, "李总");
  assert.deepEqual(
    config.attendees.map((a) => a.callName),
    ["王部长", "供应链部部长"]
  );
  // no chair name: the post is what the assistant says
  assert.equal(withCallNames({ chair: "总经理", attendees: [] }).chairCallName, "总经理");
});
