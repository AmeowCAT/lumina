import type { ReactNode } from "react";
import {
  ChevronDown,
  Dices,
  Download,
  File,
  Folder,
  Image,
  Maximize2,
  Package,
  Play,
  Plus,
  Power,
  RotateCcw,
  Save,
  Upload,
  X,
} from "lucide-react";

/** 图标集 —— 保持原 IC 键名不变，统一 1.75 光学线宽，契合精密桌面工具语言。 */
export const IC: Record<string, ReactNode> = {
  dice: <Dices size={14} strokeWidth={1.75} aria-hidden="true" />,
  play: <Play size={12} fill="currentColor" strokeWidth={1.75} aria-hidden="true" />,
  x: <X size={13} strokeWidth={1.85} aria-hidden="true" />,
  dl: <Download size={13} strokeWidth={1.75} aria-hidden="true" />,
  upload: <Upload size={18} strokeWidth={1.5} aria-hidden="true" />,
  plus: <Plus size={13} strokeWidth={1.85} aria-hidden="true" />,
  chev: <ChevronDown size={12} strokeWidth={1.85} aria-hidden="true" />,
  folder: <Folder size={13.5} strokeWidth={1.75} aria-hidden="true" />,
  power: <Power size={13} strokeWidth={1.75} aria-hidden="true" />,
  refresh: <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />,
  box: <Package size={13.5} strokeWidth={1.75} aria-hidden="true" />,
  file: <File size={13.5} strokeWidth={1.75} aria-hidden="true" />,
  image: <Image size={13} strokeWidth={1.75} aria-hidden="true" />,
  zoom: <Maximize2 size={13} strokeWidth={1.75} aria-hidden="true" />,
  save: <Save size={13} strokeWidth={1.75} aria-hidden="true" />,
};

export { InfoTip, type InfoTipProps } from "./InfoTip";
