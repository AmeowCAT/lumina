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

/** 图标集 —— 保持原 IC 键名不变,lucide-react 实现。 */
export const IC: Record<string, ReactNode> = {
  dice: <Dices size={15} strokeWidth={1.8} aria-hidden="true" />,
  play: <Play size={13} fill="currentColor" aria-hidden="true" />,
  x: <X size={13} strokeWidth={2.2} aria-hidden="true" />,
  dl: <Download size={13} strokeWidth={2} aria-hidden="true" />,
  upload: <Upload size={22} strokeWidth={1.5} aria-hidden="true" />,
  plus: <Plus size={13} strokeWidth={2.2} aria-hidden="true" />,
  chev: <ChevronDown size={11} strokeWidth={2.2} aria-hidden="true" />,
  folder: <Folder size={14} strokeWidth={1.8} aria-hidden="true" />,
  power: <Power size={13} strokeWidth={2} aria-hidden="true" />,
  refresh: <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />,
  box: <Package size={14} strokeWidth={1.8} aria-hidden="true" />,
  file: <File size={14} strokeWidth={1.8} aria-hidden="true" />,
  image: <Image size={13} strokeWidth={1.8} aria-hidden="true" />,
  zoom: <Maximize2 size={13} strokeWidth={2} aria-hidden="true" />,
  save: <Save size={13} strokeWidth={2} aria-hidden="true" />,
};
