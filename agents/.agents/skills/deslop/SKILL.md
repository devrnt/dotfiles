---
name: deslop
description: >
  Remove AI-generated slop from the current branch: compare against main, strip extra comments,
  abnormal defensive checks, speculative try/catch, `any` casts, and style inconsistent with the file.
  Use when the user asks to deslop, remove AI slop, clean the branch, or polish a diff before review.
---

## Goal

Check the diff against `main` and remove slop introduced on this branch only. Do not rewrite unrelated code.

## What counts as slop

- Comments a human would not add, or tone inconsistent with the rest of the file
- Extra defensive checks or try/catch that are abnormal for that area (especially when callers already validate)
- Casts to `any` to silence type errors instead of fixing types
- Any style that breaks local conventions (naming, patterns, import style)

## How

1. Diff against `main` (or the branch’s merge base if `main` is not the target).
2. Edit only lines touched in that diff unless a tiny adjacent change is required for correctness.
3. Prefer deleting over adding. Prefer existing project patterns over new abstractions.

## Report

End with a **1–3 sentence** summary of what you changed. No bullet laundry list unless the user asks.
