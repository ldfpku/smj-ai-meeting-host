"use client";

import { PresetSave } from "@/components/preset-save";
import { PresetSelector } from "@/components/preset-selector";

export function Header() {
  return (
    <div className="flex flex-shrink-0 flex-col lg:flex-row p-4 rounded-t-md">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between lg:flex-grow">
        <div className="flex flex-col mb-2 lg:mb-0">
          <div className="flex flex-row items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">
                AI 会议主持人
              </h2>
              <p className="text-sm text-gray-500">
                装载公司标准会议模板，控时、纠偏、点名征询、催办四要素决议。
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-row items-center justify-between sm:justify-end space-x-2 mt-2 lg:mt-0">
          <div className="flex flex-row items-center space-x-2">
            <PresetSelector />
            <PresetSave />
          </div>
        </div>
      </div>
    </div>
  );
}
