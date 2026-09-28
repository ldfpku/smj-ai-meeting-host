"use client";

import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Trash2, Clock, Target, Users, Paperclip, Mic } from "lucide-react";
import {
  MeetingConfig,
  AgendaItem,
  Attendee,
  MeetingStyle,
  InterventionMode,
  InterventionSettings,
  defaultInterventionSettings,
  defaultMeetingConfig,
  generateMeetingInstructions,
} from "@/data/meeting";
import { Slider } from "@/components/ui/slider";
import {
  MEETING_TEMPLATES,
  templateToConfig,
  makeBlankAgenda,
  makeBlankAttendee,
} from "@/data/meeting-templates";
import {
  SMJ_DEPARTMENTS,
  SMJ_PROCESSES,
  SMJ_ROLES,
  getRolesByDept,
} from "@/data/smj-org";
import { usePlaygroundState } from "@/hooks/use-playground-state";
import { MeetingImport } from "@/components/meeting/meeting-import";
import type { ImportedMeeting } from "@/lib/meeting-import";

interface MeetingConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm?: (config: MeetingConfig) => void;
}

const selectClass =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring";

export function MeetingConfigModal({
  open,
  onOpenChange,
  onConfirm,
}: MeetingConfigModalProps) {
  const { pgState, dispatch } = usePlaygroundState();

  const initialConfig =
    pgState.sessionConfig.meetingConfig || defaultMeetingConfig;

  const [templateId, setTemplateId] = useState(initialConfig.templateId || "");
  const [meetingType, setMeetingType] = useState(initialConfig.meetingType || "");
  const [topic, setTopic] = useState(initialConfig.topic);
  const [chair, setChair] = useState(initialConfig.chair || "");
  const [style, setStyle] = useState<MeetingStyle>(initialConfig.style);
  const [requirePreRead, setRequirePreRead] = useState(
    !!initialConfig.requirePreRead
  );
  const [escalationPath, setEscalationPath] = useState(
    initialConfig.escalationPath || ""
  );
  const [agendas, setAgendas] = useState<AgendaItem[]>(initialConfig.agendas);
  const [attendees, setAttendees] = useState<Attendee[]>(
    initialConfig.attendees || []
  );
  const [intervention, setIntervention] = useState<InterventionSettings>({
    ...defaultInterventionSettings,
    ...initialConfig.intervention,
  });
  const [error, setError] = useState<string | null>(null);

  // 介入模式也能在看板上直接切换；每次打开时以当前配置为准，
  // 否则在这里点保存会把看板上刚改的模式冲回去。
  const currentIntervention = pgState.sessionConfig.meetingConfig?.intervention;
  useEffect(() => {
    if (open) {
      setIntervention({ ...defaultInterventionSettings, ...currentIntervention });
    }
  }, [open, currentIntervention]);

  const totalMinutes = agendas.reduce(
    (sum, item) => sum + (Number(item.durationMinutes) || 0),
    0
  );

  const applyTemplate = (id: string) => {
    const tpl = MEETING_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    const cfg = templateToConfig(tpl);
    setTemplateId(cfg.templateId || "");
    setMeetingType(cfg.meetingType || "");
    setTopic(cfg.topic);
    setChair(cfg.chair || "");
    setStyle(cfg.style);
    setRequirePreRead(!!cfg.requirePreRead);
    setEscalationPath(cfg.escalationPath || "");
    setAgendas(cfg.agendas);
    setAttendees(cfg.attendees);
    setError(null);
  };

  // 文档里没写的项回到默认值，不沿用上一场会议的
  const applyImport = (meeting: ImportedMeeting) => {
    setTemplateId("");
    setMeetingType(meeting.meetingType || "");
    setTopic(meeting.topic);
    setChair(meeting.chair || "");
    setStyle(meeting.style || "strict");
    setRequirePreRead(!!meeting.requirePreRead);
    setEscalationPath(meeting.escalationPath || "");
    setAgendas(meeting.agendas);
    setAttendees(meeting.attendees);
    setError(null);
  };

  const handleAddAgenda = () =>
    setAgendas([...agendas, makeBlankAgenda(agendas.length + 1)]);

  const handleRemoveAgenda = (id: string) => {
    if (agendas.length <= 1) {
      setError("至少需要保留一个会议议题");
      return;
    }
    setError(null);
    setAgendas(agendas.filter((a) => a.id !== id));
  };

  const handleUpdateAgenda = (
    id: string,
    field: keyof AgendaItem,
    value: string | number
  ) => {
    setAgendas(agendas.map((a) => (a.id === id ? { ...a, [field]: value } : a)));
  };

  const handleUpdateAttendee = (
    id: string,
    patch: Partial<Attendee>
  ) => {
    setAttendees(attendees.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  const handleSave = () => {
    if (!topic.trim()) {
      setError("请输入会议主题");
      return;
    }
    if (agendas.length === 0) {
      setError("请至少添加一个议题");
      return;
    }
    for (let i = 0; i < agendas.length; i++) {
      if (!agendas[i].title.trim()) {
        setError(`议题 ${i + 1} 的名称不能为空`);
        return;
      }
      if (agendas[i].durationMinutes <= 0) {
        setError(`议题 ${i + 1} 的预计用时必须大于 0 分钟`);
        return;
      }
    }

    // 只保留填了姓名或岗位的参会人，避免空行进入名单与纪要
    const cleanedAttendees = attendees.filter(
      (a) => a.name.trim() || a.role.trim()
    );

    const updatedConfig: MeetingConfig = {
      templateId: templateId || undefined,
      meetingType: meetingType.trim() || undefined,
      topic: topic.trim(),
      chair: chair.trim() || undefined,
      totalDurationMinutes: totalMinutes,
      agendas,
      attendees: cleanedAttendees,
      style,
      requirePreRead,
      escalationPath: escalationPath.trim() || undefined,
      intervention,
    };

    dispatch({
      type: "SET_SESSION_CONFIG",
      payload: {
        ...pgState.sessionConfig,
        meetingConfig: updatedConfig,
      },
    });

    dispatch({
      type: "SET_INSTRUCTIONS",
      payload: generateMeetingInstructions(updatedConfig),
    });

    onOpenChange(false);
    onConfirm?.(updatedConfig);
  };

  const requiredCount = attendees.filter(
    (a) => a.required && (a.name.trim() || a.role.trim())
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <DialogTitle className="text-xl">会议配置</DialogTitle>
              <DialogDescription>
                从会议文档导入、选择公司标准会议模板，或自定义议程与参会人。主持人将依此控时、点名、催办决议。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 py-2">
          <MeetingImport onImported={applyImport} />

          {/* 会议模板 */}
          <div className="space-y-2">
            <Label className="text-base font-semibold">公司标准会议模板</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {MEETING_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => applyTemplate(t.id)}
                  className={`p-2.5 text-left rounded-lg border transition-all ${
                    templateId === t.id
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <div className="font-semibold text-sm">{t.name}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {t.cadence} · {t.chair}主持 · {t.agendas.length} 项固定议题
                  </div>
                  <div className="text-[10px] text-muted-foreground/70 mt-1 truncate">
                    出处：{t.source}
                  </div>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              选择模板会覆盖当前议程与参会岗位；参会人姓名需自行填写。
            </p>
          </div>

          {/* 会议主题 / 主持 / 总用时 */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="md:col-span-2 space-y-2">
              <Label htmlFor="topic">会议名称 *</Label>
              <Input
                id="topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="例如：月度产销租协同会"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="chair">主持人（岗位）</Label>
              <select
                id="chair"
                className={`${selectClass} h-10 text-sm`}
                value={chair}
                onChange={(e) => setChair(e.target.value)}
              >
                <option value="">未指定</option>
                {SMJ_ROLES.map((r) => (
                  <option key={r.title} value={r.title}>
                    {r.title}
                  </option>
                ))}
                {chair && !SMJ_ROLES.some((r) => r.title === chair) && (
                  <option value={chair}>{chair}</option>
                )}
              </select>
            </div>
            <div className="space-y-2">
              <Label>预计总时长</Label>
              <div className="flex items-center gap-2 h-10 px-3 rounded-md border bg-muted/40 text-sm font-medium">
                <Clock className="w-4 h-4 text-muted-foreground" />
                <span>{totalMinutes} 分钟</span>
              </div>
            </div>
          </div>

          {/* 升级路径与前置材料 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2 space-y-2">
              <Label htmlFor="escalation">未决事项升级路径</Label>
              <Input
                id="escalation"
                value={escalationPath}
                onChange={(e) => setEscalationPath(e.target.value)}
                placeholder="默认：提请总经理签批并留档"
              />
            </div>
            <div className="space-y-2">
              <Label>书面前置</Label>
              <label className="flex items-center gap-2 h-10 px-3 rounded-md border bg-muted/20 text-xs cursor-pointer">
                <Checkbox
                  checked={requirePreRead}
                  onCheckedChange={(v) => setRequirePreRead(!!v)}
                />
                <span>议题材料提前 24 小时下发</span>
              </label>
            </div>
          </div>

          {/* 主持风格 */}
          <div className="space-y-2">
            <Label>主持人控场风格</Label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: "strict", label: "果断控场型", desc: "一跑题就打断并拉回" },
                { id: "gentle", label: "温和引导型", desc: "委婉提醒、建议式推进" },
                { id: "concise", label: "极简报时型", desc: "仅关键节点短小报时" },
              ].map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStyle(s.id as MeetingStyle)}
                  className={`p-3 text-left rounded-lg border transition-all ${
                    style === s.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <div className="font-semibold text-sm">{s.label}</div>
                  <div className="text-xs text-muted-foreground mt-1">{s.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 跑题介入设置 */}
          <div className="space-y-2">
            <Label>跑题介入</Label>
            <div className="grid grid-cols-2 gap-2">
              {[
                {
                  id: "auto",
                  label: "自动打断",
                  desc: "检测到跑题，AI 主持人直接开口打断",
                },
                {
                  id: "semi_auto",
                  label: "半自动",
                  desc: "只在看板上提示，由你点击后才打断",
                },
              ].map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() =>
                    setIntervention({
                      ...intervention,
                      mode: m.id as InterventionMode,
                    })
                  }
                  className={`p-3 text-left rounded-lg border transition-all ${
                    intervention.mode === m.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <div className="font-semibold text-sm">{m.label}</div>
                  <div className="text-xs text-muted-foreground mt-1">{m.desc}</div>
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span>偏题概率阈值</span>
                  <span className="font-medium tabular-nums">
                    {Math.round(intervention.threshold * 100)}%
                  </span>
                </div>
                <Slider
                  min={0.6}
                  max={0.98}
                  step={0.01}
                  value={[intervention.threshold]}
                  onValueChange={(v) =>
                    setIntervention({ ...intervention, threshold: v[0] })
                  }
                  aria-label="偏题概率阈值"
                />
                <p className="text-[11px] text-muted-foreground">
                  越高越不容易误打断，也越容易漏掉跑题。
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span>冷却时间</span>
                  <span className="font-medium tabular-nums">
                    {intervention.cooldownSeconds} 秒
                  </span>
                </div>
                <Slider
                  min={15}
                  max={180}
                  step={5}
                  value={[intervention.cooldownSeconds]}
                  onValueChange={(v) =>
                    setIntervention({ ...intervention, cooldownSeconds: v[0] })
                  }
                  aria-label="冷却时间"
                />
                <p className="text-[11px] text-muted-foreground">
                  打断一次后，这段时间内不再自动打断。
                </p>
              </div>
              <div className="space-y-2">
                <div className="text-xs">判断方式</div>
                <select
                  className={selectClass}
                  value={intervention.consecutiveHits}
                  onChange={(e) =>
                    setIntervention({
                      ...intervention,
                      consecutiveHits: parseInt(e.target.value) || 1,
                    })
                  }
                  aria-label="判断方式"
                >
                  <option value={1}>命中 1 次即介入（最快）</option>
                  <option value={2}>连续命中 2 次才介入（更稳）</option>
                </select>
                <p className="text-[11px] text-muted-foreground">
                  连续 2 次要多等一轮判断，响应会慢 1–2 秒。
                </p>
              </div>
            </div>
          </div>

          {/* 参会人名单 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base font-semibold">
                  参会人名单 ({attendees.length})
                </Label>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  勾选【必须发言】的人，主持人会在议题收尾前逐一点名征询——沉默不等于同意。
                  当前 {requiredCount} 人必须发言。
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAttendees([...attendees, makeBlankAttendee()])}
                className="h-8 gap-1 flex-shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                添加
              </Button>
            </div>

            <div className="space-y-2">
              {attendees.length === 0 && (
                <div className="text-xs text-muted-foreground border border-dashed rounded-lg p-3 text-center">
                  尚未登记参会人。选择会议模板可自动带出应参会岗位。
                </div>
              )}
              {attendees.map((a) => {
                const roleOptions = a.dept ? getRolesByDept(a.dept) : SMJ_ROLES;
                return (
                  <div
                    key={a.id}
                    className="grid grid-cols-12 gap-2 items-center p-2 rounded-lg border border-border bg-card"
                  >
                    <Input
                      value={a.name}
                      onChange={(e) =>
                        handleUpdateAttendee(a.id, { name: e.target.value })
                      }
                      placeholder="姓名"
                      className="col-span-3 h-8 text-xs"
                    />
                    <select
                      className={`${selectClass} col-span-3`}
                      value={a.dept}
                      onChange={(e) =>
                        handleUpdateAttendee(a.id, { dept: e.target.value })
                      }
                    >
                      <option value="">部门</option>
                      {SMJ_DEPARTMENTS.map((d) => (
                        <option key={d.id} value={d.name}>
                          {d.name}
                        </option>
                      ))}
                      {a.dept &&
                        !SMJ_DEPARTMENTS.some((d) => d.name === a.dept) && (
                          <option value={a.dept}>{a.dept}</option>
                        )}
                    </select>
                    <select
                      className={`${selectClass} col-span-3`}
                      value={a.role}
                      onChange={(e) =>
                        handleUpdateAttendee(a.id, { role: e.target.value })
                      }
                    >
                      <option value="">岗位</option>
                      {roleOptions.map((r) => (
                        <option key={r.title} value={r.title}>
                          {r.title}
                        </option>
                      ))}
                      {a.role && !roleOptions.some((r) => r.title === a.role) && (
                        <option value={a.role}>{a.role}</option>
                      )}
                    </select>
                    <label
                      className="col-span-2 flex items-center gap-1.5 text-[11px] cursor-pointer"
                      title="议题收尾前必须点名征询其意见"
                    >
                      <Checkbox
                        checked={a.required}
                        onCheckedChange={(v) =>
                          handleUpdateAttendee(a.id, { required: !!v })
                        }
                      />
                      <span>必须发言</span>
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        setAttendees(attendees.filter((x) => x.id !== a.id))
                      }
                      className="col-span-1 h-6 w-6 justify-self-end text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 议程列表 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-base font-semibold">
                议程序列与目标 ({agendas.length})
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddAgenda}
                className="h-8 gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                添加议题
              </Button>
            </div>

            <div className="space-y-3">
              {agendas.map((item, index) => (
                <div
                  key={item.id}
                  className="p-3 rounded-lg border border-border bg-card space-y-2.5 relative group"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold px-2 py-0.5 rounded bg-muted text-muted-foreground">
                      议题 {index + 1}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemoveAgenda(item.id)}
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      disabled={agendas.length <= 1}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                    <div className="md:col-span-3">
                      <Input
                        value={item.title}
                        onChange={(e) =>
                          handleUpdateAgenda(item.id, "title", e.target.value)
                        }
                        placeholder="议题名称，例如：瓶颈工序"
                        className="text-sm font-medium"
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        min="1"
                        max="180"
                        value={item.durationMinutes}
                        onChange={(e) =>
                          handleUpdateAgenda(
                            item.id,
                            "durationMinutes",
                            parseInt(e.target.value) || 0
                          )
                        }
                        className="text-sm w-20 text-center"
                      />
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        分钟
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Target className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <Input
                      value={item.goal}
                      onChange={(e) =>
                        handleUpdateAgenda(item.id, "goal", e.target.value)
                      }
                      placeholder="预期落地决议目标"
                      className="text-xs text-muted-foreground h-8"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <Mic className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <Input
                      value={item.presenter || ""}
                      onChange={(e) =>
                        handleUpdateAgenda(item.id, "presenter", e.target.value)
                      }
                      list="meeting-presenters"
                      placeholder="汇报人：议题开始时请谁先介绍情况（可选）"
                      className="text-xs h-8"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <select
                      className={selectClass}
                      value={item.processId || ""}
                      onChange={(e) =>
                        handleUpdateAgenda(item.id, "processId", e.target.value)
                      }
                    >
                      <option value="">关联流程（可选）</option>
                      {SMJ_PROCESSES.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id} {p.name}
                        </option>
                      ))}
                    </select>
                    <div className="md:col-span-2 flex items-center gap-2">
                      <Paperclip className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      <Input
                        value={item.preReadRef || ""}
                        onChange={(e) =>
                          handleUpdateAgenda(item.id, "preReadRef", e.target.value)
                        }
                        placeholder="前置材料（提前 24 小时下发）"
                        className="text-xs h-8"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <datalist id="meeting-presenters">
            {attendees
              .map((a) => a.name.trim() || a.role.trim())
              .filter(Boolean)
              .map((label) => (
                <option key={label} value={label} />
              ))}
          </datalist>

          {error && (
            <div className="text-xs text-destructive bg-destructive/10 p-2.5 rounded-md">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} className="gap-1.5">
            确认并保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
