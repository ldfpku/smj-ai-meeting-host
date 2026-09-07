"use client";

import React, { useState } from "react";
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
import { Plus, Trash2, Clock, Target, Users } from "lucide-react";
import {
  MeetingConfig,
  AgendaItem,
  defaultMeetingConfig,
  generateMeetingInstructions,
} from "@/data/meeting";
import { usePlaygroundState } from "@/hooks/use-playground-state";

interface MeetingConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm?: (config: MeetingConfig) => void;
}

export function MeetingConfigModal({
  open,
  onOpenChange,
  onConfirm,
}: MeetingConfigModalProps) {
  const { pgState, dispatch } = usePlaygroundState();

  const initialConfig =
    pgState.sessionConfig.meetingConfig || defaultMeetingConfig;

  const [topic, setTopic] = useState(initialConfig.topic);
  const [style, setStyle] = useState<"strict" | "gentle" | "concise">(
    initialConfig.style
  );
  const [agendas, setAgendas] = useState<AgendaItem[]>(initialConfig.agendas);
  const [error, setError] = useState<string | null>(null);

  const totalMinutes = agendas.reduce(
    (sum, item) => sum + (Number(item.durationMinutes) || 0),
    0
  );

  const handleAddAgenda = () => {
    const newItem: AgendaItem = {
      id: `agenda-${Date.now()}`,
      title: `新议题 ${agendas.length + 1}`,
      durationMinutes: 10,
      goal: "明确决议与下一步",
    };
    setAgendas([...agendas, newItem]);
  };

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
    setAgendas(
      agendas.map((a) => (a.id === id ? { ...a, [field]: value } : a))
    );
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

    const updatedConfig: MeetingConfig = {
      topic: topic.trim(),
      totalDurationMinutes: totalMinutes,
      agendas,
      style,
    };

    // Update meetingConfig and instructions in playground state
    dispatch({
      type: "SET_SESSION_CONFIG",
      payload: {
        ...pgState.sessionConfig,
        meetingConfig: updatedConfig,
      },
    });

    const newInstructions = generateMeetingInstructions(updatedConfig);
    dispatch({
      type: "SET_INSTRUCTIONS",
      payload: newInstructions,
    });

    onOpenChange(false);
    if (onConfirm) {
      onConfirm(updatedConfig);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <DialogTitle className="text-xl">会议主持人议程配置</DialogTitle>
              <DialogDescription>
                设定会议主题、细分议程用时与主持风格。主持人将依此控时与把控跑题。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* 会议主题 & 总用时 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 space-y-2">
              <Label htmlFor="topic">会议主题 *</Label>
              <Input
                id="topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="例如：2026 Q3 产品技术方案评审"
              />
            </div>
            <div className="space-y-2">
              <Label>预计总时长</Label>
              <div className="flex items-center gap-2 h-10 px-3 rounded-md border bg-muted/40 text-sm font-medium">
                <Clock className="w-4 h-4 text-muted-foreground" />
                <span>{totalMinutes} 分钟</span>
              </div>
            </div>
          </div>

          {/* 主持风格 */}
          <div className="space-y-2">
            <Label>主持人控场风格</Label>
            <div className="grid grid-cols-3 gap-2">
              {[
                {
                  id: "strict",
                  label: "果断控场型",
                  desc: "跑题超2轮即介入拉回",
                },
                {
                  id: "gentle",
                  label: "温和引导型",
                  desc: "委婉提醒、建议式推进",
                },
                {
                  id: "concise",
                  label: "极简报时型",
                  desc: "仅关键节点短小报时",
                },
              ].map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() =>
                    setStyle(s.id as "strict" | "gentle" | "concise")
                  }
                  className={`p-3 text-left rounded-lg border transition-all ${
                    style === s.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <div className="font-semibold text-sm">{s.label}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {s.desc}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 议程列表 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-base font-semibold">
                细分议程序列与目标 ({agendas.length})
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
                  className="p-3 rounded-lg border border-border bg-card space-y-3 relative group"
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
                        placeholder="议题名称，例如：核心方案PK"
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
                      placeholder="预期落地决议目标，例如：敲定技术选型与排期"
                      className="text-xs text-muted-foreground h-8"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

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
            确认并保存议程
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
