
import json


json_string = '{ "correct": true }'

if __name__ == "__main__":
    o = json.loads(json_string)    
    correct = o.get("correct", False)
    if isinstance(correct, str):
        correct = correct.lower() in ("true", "1", "yes", "correct", "richtig")