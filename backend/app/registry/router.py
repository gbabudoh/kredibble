"""Trains the intent router: TF-IDF (word 1–2 grams) + multinomial logistic regression.

Only the export step needs scikit-learn (a dev dependency). The trained model is
exported as plain numbers — vocabulary, idf, coefficients — and the web client
re-implements inference in a few lines, so routing runs on-device in ~1 ms.
"""
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix

from app.registry.intents import TEST, TRAIN

ROUND = 5  # decimals kept in the export; keeps the JSON small without changing predictions

PARITY_SAMPLES = [
    "What is the liability cap?",
    "Summarise this agreement.",
    "Extract all the dates and amounts.",
    "Is this DPA GDPR compliant?",
    "What's the capital of France?",
    "And how much notice does that require?",
]


def _flatten(data: dict):
    texts, labels = [], []
    for label, examples in data.items():
        texts.extend(examples)
        labels.extend([label] * len(examples))
    return texts, labels


def train():
    texts, labels = _flatten(TRAIN)
    vectorizer = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, lowercase=True)
    X = vectorizer.fit_transform(texts)
    model = LogisticRegression(C=10.0, max_iter=5000)
    model.fit(X, labels)
    return vectorizer, model


def evaluate(vectorizer, model) -> dict:
    texts, labels = _flatten(TEST)
    predicted = model.predict(vectorizer.transform(texts))
    classes = list(model.classes_)
    return {
        "accuracy": round(float(accuracy_score(labels, predicted)), 4),
        "n": len(texts),
        "classes": classes,
        "confusion": confusion_matrix(labels, predicted, labels=classes).tolist(),
        "errors": [{"text": t, "expected": e, "got": g} for t, e, g in zip(texts, labels, predicted) if e != g],
    }


def export_router(vectorizer, model) -> dict:
    vocab = {term: int(i) for term, i in sorted(vectorizer.vocabulary_.items(), key=lambda kv: kv[1])}
    parity = []
    for text, probs in zip(PARITY_SAMPLES, model.predict_proba(vectorizer.transform(PARITY_SAMPLES))):
        parity.append({"text": text, "probs": {c: round(float(p), 4) for c, p in zip(model.classes_, probs)}})
    return {
        "kind": "tfidf-logreg",
        "ngram_range": [1, 2],
        "sublinear_tf": True,
        "classes": list(model.classes_),
        "vocabulary": vocab,
        "idf": [round(float(v), ROUND) for v in vectorizer.idf_],
        "coef": [[round(float(v), ROUND) for v in row] for row in model.coef_],
        "intercept": [round(float(v), ROUND) for v in model.intercept_],
        "parity": parity,
    }
