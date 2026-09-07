'use client';

import { useTheme } from "next-themes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Moon, Sun, Monitor } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";

export function ThemeToggle() {
  const { setTheme, theme } = useTheme();
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  // When collapsed, show icon button with popover
  if (isCollapsed) {
    const getThemeIcon = () => {
      switch (theme) {
        case 'light':
          return <Sun className="h-4 w-4" />;
        case 'dark':
          return <Moon className="h-4 w-4" />;
        default:
          return <Monitor className="h-4 w-4" />;
      }
    };

    return (
      <div className="relative">
        <Popover>
          <PopoverTrigger asChild>
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-9 w-9"
            >
              {getThemeIcon()}
              <span className="sr-only">切换主题</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent 
            className="w-48"
          >
            <div className="space-y-2">
              <h4 className="font-medium leading-none">主题</h4>
              <div className="space-y-1">
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => setTheme('light')}
                >
                  <Sun className="mr-2 h-4 w-4" />
                  浅色
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => setTheme('dark')}
                >
                  <Moon className="mr-2 h-4 w-4" />
                  深色
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => setTheme('system')}
                >
                  <Monitor className="mr-2 h-4 w-4" />
                  跟随系统
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  // When expanded, show the full select dropdown
  return (
    <Select value={theme} onValueChange={setTheme}>
      <SelectTrigger className="w-full" variant="ghost" size="md">
        <SelectValue placeholder="主题" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="light">
          <div className="flex items-center gap-2">
            <Sun className="h-4 w-4" />
            浅色
          </div>
        </SelectItem>
        <SelectItem value="dark">
          <div className="flex items-center gap-2">
            <Moon className="h-4 w-4" />
            深色
          </div>
        </SelectItem>
        <SelectItem value="system">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4" />
            跟随系统
          </div>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
