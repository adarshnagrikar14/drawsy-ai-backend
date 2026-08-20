#!/usr/bin/env python3
"""Convert the released BEAM parquet rows to the evaluator's JSONL shape.

This keeps BEAM's official parquet distribution untouched. The Node evaluator
then ingests each complete conversation into HydraDB OSS and queries it for
every released probing question in that conversation.
"""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
from typing import Any, Iterable


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def parse_questions(value: str, conversation_id: str) -> list[dict[str, Any]]:
    try:
        parsed = ast.literal_eval(value)
    except (SyntaxError, ValueError) as exc:
        raise RuntimeError(f"Could not parse probing_questions for conversation {conversation_id}") from exc
    require(isinstance(parsed, dict), f"BEAM probing_questions must be an object for {conversation_id}")
    questions: list[dict[str, Any]] = []
    for category, entries in parsed.items():
        require(isinstance(category, str) and category, "BEAM question category must be non-empty")
        require(isinstance(entries, list), f"BEAM question category {category} must be a list")
        for index, entry in enumerate(entries):
            require(isinstance(entry, dict), f"BEAM question {category}[{index}] must be an object")
            question = entry.get("question")
            require(isinstance(question, str) and question.strip(), f"BEAM question {category}[{index}] is empty")
            ideal_response = entry.get("ideal_response")
            answer = ideal_response if isinstance(ideal_response, str) else entry.get("answer")
            questions.append(
                {
                    "id": f"{conversation_id}:{category}:{index}",
                    "question": question.strip(),
                    "answerText": answer.strip() if isinstance(answer, str) and answer.strip() else None,
                    "category": category,
                    "abstention": category == "abstention",
                    "imagePresent": False,
                }
            )
    return questions


def record_text(batch: Iterable[dict[str, Any]]) -> tuple[str, str]:
    parts: list[str] = []
    observed_at = "2026-01-01T00:00:00.000Z"
    for message in batch:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "turn").strip()
        content = str(message.get("content") or "").strip()
        if message.get("time_anchor"):
            observed_at = str(message["time_anchor"])
        if content:
            parts.append(f"{role}: {content}")
    return "\n\n".join(parts), observed_at


def convert(path: Path, output: Path) -> dict[str, int]:
    try:
        import pyarrow.parquet as parquet
    except ImportError as exc:
        raise RuntimeError(
            "BEAM export requires pyarrow. Install it in the evaluation environment, "
            "for example: python3 -m pip install pyarrow"
        ) from exc

    parquet_file = parquet.ParquetFile(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    conversations = 0
    questions = 0
    with output.open("w", encoding="utf-8") as handle:
        for batch in parquet_file.iter_batches(
            batch_size=1,
            columns=["conversation_id", "conversation_plan", "chat", "probing_questions"],
        ):
            row = batch.to_pylist()[0]
            conversation_id = str(row.get("conversation_id") or "").strip()
            require(conversation_id, "BEAM conversation_id must be non-empty")
            records: list[dict[str, str]] = []
            chat = row.get("chat") or []
            for index, turns in enumerate(chat):
                text, observed_at = record_text(turns if isinstance(turns, list) else [])
                if text:
                    records.append(
                        {
                            "sourceId": f"{conversation_id}:batch:{index}",
                            "text": text,
                            "observedAt": observed_at,
                        }
                    )
            if not records:
                plan = str(row.get("conversation_plan") or "").strip()
                require(plan, f"BEAM conversation {conversation_id} has no chat text or plan")
                records.append(
                    {
                        "sourceId": f"{conversation_id}:plan",
                        "text": plan,
                        "observedAt": "2026-01-01T00:00:00.000Z",
                    }
                )
            case_rows = parse_questions(str(row.get("probing_questions") or ""), conversation_id)
            questions += len(case_rows)
            conversations += 1
            handle.write(
                json.dumps(
                    {
                        "groupId": conversation_id,
                        "records": records,
                        "cases": case_rows,
                    },
                    ensure_ascii=True,
                )
                + "\n"
            )
    return {"conversations": conversations, "questions": questions}


def main() -> None:
    parser = argparse.ArgumentParser(description="Export an official BEAM parquet file for Drawsy Hydra evaluation.")
    parser.add_argument("--input", required=True, help="Official BEAM parquet file")
    parser.add_argument("--output", required=True, help="Normalized JSONL output path")
    args = parser.parse_args()
    result = convert(Path(args.input).expanduser().resolve(), Path(args.output).expanduser().resolve())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
