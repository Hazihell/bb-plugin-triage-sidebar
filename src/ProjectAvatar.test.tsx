// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectAvatar } from "./ProjectAvatar";
import { avatarBackground, projectHue } from "./project-avatar";

afterEach(cleanup);

const PROJECT = { id: "proj_1", name: "my cool app" };

/** The avatar renders exactly one element, with nothing wrapped around it. */
function avatarElement(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

describe("ProjectAvatar", () => {
  it("draws the monogram when nothing is stored", () => {
    render(<ProjectAvatar project={PROJECT} />);
    expect(screen.getByText("MC")).toBeDefined();
  });

  it("paints the hashed hue through an inline style, not a class", () => {
    render(<ProjectAvatar project={PROJECT} />);
    const style = screen.getByText("MC").getAttribute("style") ?? "";
    // Inline because a hashed hue cannot come from a Tailwind theme token.
    // See the comment in ProjectAvatar.tsx before changing this.
    expect(style).toContain(avatarBackground(projectHue("proj_1")));
  });

  it("carries the white text in the same style as the background", () => {
    render(<ProjectAvatar project={PROJECT} />);
    const monogram = screen.getByText("MC");
    // Together, or the contrast guarantee is only half applied: the
    // background's lightness was chosen so white clears 4.5:1 on every hue.
    expect(monogram.style.color).toBe("rgb(255, 255, 255)");
    expect(monogram.className).not.toContain("text-white");
  });

  it("draws a stored emoji instead of the monogram", () => {
    render(<ProjectAvatar project={PROJECT} stored={{ customEmoji: "🐙" }} />);
    expect(screen.getByText("🐙")).toBeDefined();
    expect(screen.queryByText("MC")).toBeNull();
  });

  it("draws a cached remote image as a plain, decorative img", () => {
    const { container } = render(
      <ProjectAvatar project={PROJECT} stored={{ remoteImage: "/org.png" }} />,
    );
    const image = avatarElement(container) as HTMLImageElement;
    expect(image.tagName).toBe("IMG");
    expect(image.getAttribute("src")).toBe("/org.png");
    // Decorative: the project's name is already beside the chip.
    expect(image.getAttribute("alt")).toBe("");
  });

  // A 404 on a cached avatar must not leave a torn-page icon in the sidebar;
  // the row still has to say which project it belongs to.
  it("falls back to the monogram when the image fails to load", () => {
    const { container } = render(
      <ProjectAvatar project={PROJECT} stored={{ remoteImage: "/gone.png" }} />,
    );
    fireEvent.error(avatarElement(container));
    expect(screen.getByText("MC")).toBeDefined();
    expect(document.querySelector("img")).toBeNull();
  });

  // The failure is remembered per src, so a project given a new image after a
  // broken one still gets to try it.
  it("tries again when the src changes after a failure", () => {
    const view = render(
      <ProjectAvatar project={PROJECT} stored={{ remoteImage: "/gone.png" }} />,
    );
    fireEvent.error(avatarElement(view.container));
    view.rerender(
      <ProjectAvatar project={PROJECT} stored={{ remoteImage: "/new.png" }} />,
    );
    const image = document.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/new.png");
  });

  describe("the box", () => {
    // A chip that measured its own content would move the project name every
    // time an avatar finished loading.
    it("is a fixed size that never yields to its content", () => {
      render(<ProjectAvatar project={PROJECT} size="sm" />);
      const className = screen.getByText("MC").className;
      expect(className).toContain("size-3.5");
      expect(className).toContain("shrink-0");
    });

    it("has a larger fixed size at md", () => {
      render(<ProjectAvatar project={PROJECT} size="md" />);
      expect(screen.getByText("MC").className).toContain("size-5");
    });

    it("holds its size for an image too", () => {
      const { container } = render(
        <ProjectAvatar
          project={PROJECT}
          stored={{ remoteImage: "/org.png" }}
          size="md"
        />,
      );
      const className = avatarElement(container).className;
      expect(className).toContain("size-5");
      expect(className).toContain("shrink-0");
    });

    // A rounded square, not a circle: a circle reads as a person, and these
    // are projects.
    it("is a rounded square, never a circle", () => {
      render(<ProjectAvatar project={PROJECT} />);
      const className = screen.getByText("MC").className;
      expect(className).toContain("rounded-sm");
      expect(className).not.toContain("rounded-full");
    });

    it("accepts extra classes from the row that places it", () => {
      render(<ProjectAvatar project={PROJECT} className="mr-1" />);
      expect(screen.getByText("MC").className).toContain("mr-1");
    });
  });

  // An unnameable project keeps its coloured square rather than collapsing:
  // the colour alone is still an identity, and a collapsed chip would shift
  // the line it sits on.
  it("keeps its box when the name yields no letters", () => {
    const { container } = render(
      <ProjectAvatar project={{ id: "proj_1", name: "---" }} />,
    );
    const box = avatarElement(container);
    expect(box.textContent).toBe("");
    expect(box.className).toContain("size-3.5");
  });
});
