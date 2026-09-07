import { Button } from "@/components/ui/button";
import { Edit, Settings, AudioLines } from "lucide-react";
import { ConfigurationFormDrawer } from "@/components/configuration-form-drawer";

interface ChatControlsProps {
  showEditButton: boolean;
  isEditingInstructions: boolean;
  onToggleEdit: () => void;
}

export function ChatControls({
  showEditButton,
  isEditingInstructions,
  onToggleEdit,
}: ChatControlsProps) {
  return (
    <div className="absolute top-2 left-2 right-2 flex justify-between">
      <div className="flex gap-2">
        <ConfigurationFormDrawer>
          <Button
            variant="outline"
            size="icon"
            className="md:hidden"
            aria-label="打开配置"
            title="打开配置"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </ConfigurationFormDrawer>
      </div>
      <div className="flex gap-2">
        {showEditButton && (
          <Button
            variant="outline"
            size="icon"
            onClick={onToggleEdit}
            aria-label={isEditingInstructions ? "返回语音视图" : "编辑系统指令"}
            title={isEditingInstructions ? "返回语音视图" : "编辑系统指令"}
          >
            {isEditingInstructions ? (
              <AudioLines className="h-4 w-4" />
            ) : (
              <Edit className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
