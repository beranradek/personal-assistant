import { styleText } from "node:util";

export const colors = {
  prompt: (text: string) => styleText(["bold", "green"], text),
  label: (text: string) => styleText(["bold", "cyan"], text),
  error: (text: string) => styleText("red", text),
  dim: (text: string) => styleText("dim", text),
  warning: (text: string) => styleText("yellow", text),
  bold: (text: string) => styleText("bold", text),
};
