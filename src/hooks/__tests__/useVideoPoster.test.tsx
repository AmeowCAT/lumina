import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useVideoPoster } from "../useVideoPoster";

function Probe({ url }: { url: string | null }) {
  const poster = useVideoPoster(url);
  return <div data-testid="poster">{poster ?? "none"}</div>;
}

describe("useVideoPoster", () => {
  it("returns null for an empty url", () => {
    const { getByTestId } = render(<Probe url={null} />);
    expect(getByTestId("poster").textContent).toBe("none");
  });

  it("stays null when the media cannot fire events (jsdom), without crashing", () => {
    const { getByTestId } = render(<Probe url="blob:fake-video" />);
    expect(getByTestId("poster").textContent).toBe("none");
  });
});
