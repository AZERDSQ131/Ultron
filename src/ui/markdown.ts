import chalk from "chalk";

/**
 * Renders the small Markdown subset currently supported by the terminal UI.
 * The pending buffer lets markers split across streamed model chunks work too.
 */
export class MarkdownStreamRenderer {
  private pending = "";
  private bold = false;

  push(text: string): string {
    this.pending += text;
    let output = "";

    while (true) {
      const markerIndex = this.pending.indexOf("**");
      if (markerIndex === -1) {
        if (this.pending.endsWith("*")) {
          output += this.render(this.pending.slice(0, -1));
          this.pending = "*";
        } else {
          output += this.render(this.pending);
          this.pending = "";
        }
        break;
      }

      output += this.render(this.pending.slice(0, markerIndex));
      this.bold = !this.bold;
      this.pending = this.pending.slice(markerIndex + 2);
    }

    return output;
  }

  flush(): string {
    const output = this.render(this.pending);
    this.pending = "";
    return output;
  }

  private render(text: string): string {
    return this.bold ? chalk.bold(text) : text;
  }
}
