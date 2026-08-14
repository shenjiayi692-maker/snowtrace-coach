import type { Metadata } from "next";
import { CoachApp } from "./coach-app";

export const metadata: Metadata = {
  title: "Snowtrace — AI Snowboard Progression Coach",
  description: "Compare your carving to a reference run with evidence you can see and drills you can ride.",
};

export default function Home() {
  return <CoachApp />;
}
